/**
 * Батчер фигур на WebGL2.
 *
 * Одна инстансированная четвёрка вершин и один вызов отрисовки на весь кадр.
 * Canvas 2D не тянет две тысячи частиц с обводками — это и есть причина, по
 * которой WebGL2 стоит в воротах версии 0.2.0, а не «когда-нибудь потом»
 * (ROADMAP, TECH §3).
 *
 * Фигуры рисуются знаковым полем расстояния, а не геометрией. Три выгоды
 * сразу, и все три нужны именно этой игре:
 *
 *   — **толстая обводка бесплатно.** Арт-дирекшн требует обводку 4 u на всём
 *     (GDD §21), а обводка геометрией — это второй набор треугольников на
 *     каждую фигуру и вдвое больше вершин.
 *   — **сглаживание без MSAA.** Край считается по расстоянию, поэтому мелкая
 *     частица не превращается в лесенку и не требует буфера с мультисэмплом.
 *   — **одна вершинная раскладка на всё.** Круг, треугольник, шестиугольник и
 *     капсула отличаются одним числом в инстансе, поэтому и попадают в один
 *     батч. Разные наборы вершин означали бы разные вызовы отрисовки.
 *
 * Буква — такой же инстанс, как круг, и это решение того же порядка. Текст
 * приехал в F2 (PRODUCTION §4), и рисовать его вторым проходом поверх кадра
 * означало бы разменять «весь кадр одним вызовом» на удобство: HUD, карты и
 * подписи перемешаны по глубине, поэтому проходов вышло бы не два, а столько,
 * сколько раз текст чередуется с фигурами. Вместо этого глиф — фигура
 * `Shape.Glyph` с прямоугольником в атласе вместо поля расстояния.
 *
 * Цвета сюда приходят готовыми: палитра живёт в одном месте (PRODUCTION §8),
 * и знать о ней рендеру незачем.
 */

export const enum Shape {
  Circle = 0,
  Box = 1,
  Triangle = 2,
  Hexagon = 3,
  /** Кольцо: заливки нет, есть только обводка. */
  Ring = 4,
  /** Капсула вдоль X: снаряды, коридоры телеграфов, лучи. */
  Capsule = 5,
  /** Буква из атласа глифов: форму задаёт текстура, а не поле расстояния. */
  Glyph = 6,
}

/** Сколько чисел занимает один инстанс. */
const STRIDE = 20;
/** Потолок фигур в кадре: 2000 частиц, 200 болванок, HUD и запас. */
const CAPACITY = 8192;

const VERTEX_SRC = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 iPosSize;   // xy — центр, zw — полуразмеры
layout(location = 2) in vec4 iRotShape;  // x — поворот, y — фигура, z — обводка
layout(location = 3) in vec4 iFill;
layout(location = 4) in vec4 iStroke;
layout(location = 5) in vec4 iUv;        // xy — левый верх в атласе, zw — правый низ

/** xy — масштаб единиц арены в клип-пространство, zw — сдвиг. */
uniform vec4 uView;

out vec2 vLocal;
out vec2 vHalf;
flat out float vShape;
flat out float vStroke;
out vec4 vFill;
out vec4 vStrokeColor;
flat out vec4 vUv;

void main() {
  vec2 half_ = iPosSize.zw;
  float stroke = iRotShape.z;
  // Расширяем четвёрку под обводку и под пиксель сглаживания: иначе край
  // фигуры срезается собственной геометрией.
  vec2 pad = vec2(stroke * 0.5 + 2.0);
  vec2 local = aCorner * (half_ + pad) * 2.0;

  float a = iRotShape.x;
  float c = cos(a);
  float s = sin(a);
  vec2 rotated = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  vec2 world = iPosSize.xy + rotated;

  vLocal = local;
  vHalf = half_;
  vShape = iRotShape.y;
  vStroke = stroke;
  vFill = iFill;
  vStrokeColor = iStroke;
  vUv = iUv;

  gl_Position = vec4(world * uView.xy + uView.zw, 0.0, 1.0);
}
`;

const FRAGMENT_SRC = `#version 300 es
precision highp float;

in vec2 vLocal;
in vec2 vHalf;
flat in float vShape;
flat in float vStroke;
in vec4 vFill;
in vec4 vStrokeColor;
flat in vec4 vUv;

uniform sampler2D uAtlas;

out vec4 outColor;

/** Прямоугольник со скруглением. */
float sdBox(vec2 p, vec2 b, float r) {
  vec2 d = abs(p) - b + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

/** Правильный треугольник, вершиной вправо: так его удобно поворачивать. */
float sdTriangle(vec2 p, float r) {
  const float k = 1.7320508;
  p = vec2(-p.y, p.x);
  p.x = abs(p.x) - r;
  p.y = p.y + r / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}

float sdHexagon(vec2 p, float r) {
  const vec3 k = vec3(-0.8660254, 0.5, 0.5773503);
  p = abs(p);
  p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
  p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
  return length(p) * sign(p.y);
}

/** Капсула вдоль X: отрезок длиной 2·(b.x−b.y) с радиусом b.y. */
float sdCapsule(vec2 p, vec2 b) {
  float half_ = max(b.x - b.y, 0.0);
  p.x -= clamp(p.x, -half_, half_);
  return length(p) - b.y;
}

void main() {
  vec2 p = vLocal;
  vec2 h = max(vHalf, vec2(0.001));
  float d;

  /*
   * Выборка из атласа считается ВСЕГДА, а не внутри ветки глифа.
   *
   * Выборка в неоднородном ветвлении берёт производные от соседних
   * фрагментов, часть которых в эту ветку не зашла, — то есть уровень
   * детализации там не определён. Стоит это одной выборки на фигуру;
   * альтернатива — буквы, мылящиеся на одних драйверах и чёткие на других.
   */
  vec2 uvT = clamp(p / (2.0 * h) + 0.5, 0.0, 1.0);
  float glyph = texture(uAtlas, mix(vUv.xy, vUv.zw, uvT)).a;

  if (vShape > 5.5) {
    // Буква: форму несёт альфа атласа, сглаживание — билинейная фильтрация.
    // Цвет приходит предумноженным, как и у всех остальных фигур.
    outColor = vFill * glyph;
    if (outColor.a < 0.002) discard;
    return;
  }

  if (vShape < 0.5 || (vShape > 3.5 && vShape < 4.5)) {
    // Круг и кольцо: неравные полуразмеры дают squash-and-stretch —
    // расплющивание при ударе, без которого попадание не читается телом.
    vec2 q = p / h;
    d = (length(q) - 1.0) * min(h.x, h.y);
  } else if (vShape < 1.5) {
    d = sdBox(p, h, min(h.x, h.y) * 0.25);
  } else if (vShape < 2.5) {
    d = sdTriangle(p / h * min(h.x, h.y), min(h.x, h.y));
  } else if (vShape < 3.5) {
    d = sdHexagon(p / h * min(h.x, h.y), min(h.x, h.y));
  } else {
    d = sdCapsule(p, h);
  }

  // Ширина сглаживания — один экранный пиксель в локальных единицах.
  float aa = max(fwidth(d), 0.0001);
  float fill = 1.0 - smoothstep(-aa, aa, d);
  float stroke = vStroke <= 0.0
    ? 0.0
    : 1.0 - smoothstep(vStroke * 0.5 - aa, vStroke * 0.5 + aa, abs(d));

  vec4 body = vFill * fill;
  vec4 edge = vStrokeColor * stroke;
  // Обводка поверх заливки: она несёт форму, и терять её под заливкой нельзя.
  outColor = edge + body * (1.0 - edge.a);
  if (outColor.a < 0.002) discard;
}
`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('не удалось создать шейдер');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`шейдер не собрался: ${gl.getShaderInfoLog(sh) ?? ''}`);
  }
  return sh;
}

export class ShapeBatch {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly instanceBuffer: WebGLBuffer;
  private readonly viewLocation: WebGLUniformLocation;
  /**
   * Атлас глифов. До его готовности — прозрачный пиксель.
   *
   * Заглушка нужна не для красоты: шрифт грузится асинхронно, а первый кадр
   * рисуется раньше. Непривязанная текстура читается как чёрный непрозрачный
   * пиксель, то есть каждый глиф в этом кадре был бы чёрным квадратом.
   */
  private atlas: WebGLTexture;
  /** Инстансы кадра. Предаллоцирован: рендер тоже не аллоцирует в кадре. */
  private readonly data = new Float32Array(CAPACITY * STRIDE);
  private count = 0;
  /** Сколько фигур не поместилось: молчаливая потеря хуже честного счётчика. */
  dropped = 0;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;

    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SRC);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
    const program = gl.createProgram();
    if (!program) throw new Error('не удалось создать программу');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`программа не слинковалась: ${gl.getProgramInfoLog(program) ?? ''}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = program;

    const view = gl.getUniformLocation(program, 'uView');
    if (!view) throw new Error('нет uniform uView');
    this.viewLocation = view;

    const stub = gl.createTexture();
    if (!stub) throw new Error('не удалось создать текстуру атласа');
    gl.bindTexture(gl.TEXTURE_2D, stub);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]),
    );
    this.atlas = stub;
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, 'uAtlas'), 0);

    const vao = gl.createVertexArray();
    const corners = gl.createBuffer();
    const instances = gl.createBuffer();
    if (!vao || !corners || !instances) throw new Error('не удалось создать буферы');
    this.vao = vao;
    this.instanceBuffer = instances;

    gl.bindVertexArray(vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    // Единичная четвёрка вокруг нуля — общая для всех фигур.
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, instances);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    const bytes = STRIDE * 4;
    for (let i = 0; i < 5; i++) {
      const loc = i + 1;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, bytes, i * 16);
      gl.vertexAttribDivisor(loc, 1);
    }

    gl.bindVertexArray(null);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  begin(): void {
    this.count = 0;
    this.dropped = 0;
  }

  /**
   * Подставить атлас глифов. Владелец текстуры — тот, кто её собрал.
   *
   * Атлас один на кадр и на обе гарнитуры: две текстуры означали бы два вызова
   * отрисовки, то есть ровно то, ради отказа от чего буква и стала фигурой.
   */
  setAtlas(texture: WebGLTexture): void {
    this.atlas = texture;
  }

  /**
   * Добавить фигуру. Цвета — предумноженные на альфу, как того требует режим
   * смешивания: иначе полупрозрачные частицы дают тёмную кайму.
   *
   * `u0..v1` — прямоугольник в атласе, и он нужен только `Shape.Glyph`.
   * Умолчания оставляют его нулевым: остальные полторы сотни вызовов про атлас
   * не знают и знать не должны.
   */
  push(
    shape: Shape,
    x: number,
    y: number,
    halfW: number,
    halfH: number,
    rotation: number,
    fillR: number,
    fillG: number,
    fillB: number,
    fillA: number,
    strokeWidth: number,
    strokeR: number,
    strokeG: number,
    strokeB: number,
    strokeA: number,
    u0 = 0,
    v0 = 0,
    u1 = 0,
    v1 = 0,
  ): void {
    if (this.count >= CAPACITY) {
      this.dropped++;
      return;
    }
    const o = this.count * STRIDE;
    const d = this.data;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = halfW;
    d[o + 3] = halfH;
    d[o + 4] = rotation;
    d[o + 5] = shape;
    d[o + 6] = strokeWidth;
    d[o + 7] = 0;
    d[o + 8] = fillR * fillA;
    d[o + 9] = fillG * fillA;
    d[o + 10] = fillB * fillA;
    d[o + 11] = fillA;
    d[o + 12] = strokeR * strokeA;
    d[o + 13] = strokeG * strokeA;
    d[o + 14] = strokeB * strokeA;
    d[o + 15] = strokeA;
    d[o + 16] = u0;
    d[o + 17] = v0;
    d[o + 18] = u1;
    d[o + 19] = v1;
    this.count++;
  }

  /** Отправить кадр одним вызовом отрисовки. */
  flush(viewScaleX: number, viewScaleY: number, viewOffsetX: number, viewOffsetY: number): void {
    if (this.count === 0) return;
    const { gl } = this;
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.count * STRIDE);
    gl.uniform4f(this.viewLocation, viewScaleX, viewScaleY, viewOffsetX, viewOffsetY);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    gl.bindVertexArray(null);
  }

  get size(): number {
    return this.count;
  }
}
