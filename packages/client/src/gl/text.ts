/**
 * Типографика: атлас глифов и укладка строки в тот же батч, что и фигуры.
 *
 * Стадия F2 (PRODUCTION §4) привезла в кадр первую букву, и главный вопрос был
 * не «какой шрифт», а «каким проходом». Ответ — тем же самым: буква приезжает
 * в батч фигурой `Shape.Glyph`, у которой вместо поля расстояния прямоугольник
 * в атласе. Отдельный текстовый проход поверх кадра стоил бы «весь кадр одним
 * вызовом»: подписи перемешаны с фигурами по глубине, и проходов вышло бы не
 * два, а столько, сколько раз текст чередуется с фигурами.
 *
 * Атлас растрируется **один раз на загрузку** канвасом 2D. Растр, а не поле
 * расстояния: SDF-атлас красив на любом кегле, но требует сборочного шага с
 * разбором TTF, а игра показывает текст в диапазоне от 14 до 40 единиц — там
 * честный растр в 64 пикселя не отличить, а конвейера он не добавляет.
 *
 * Знать заранее, какие буквы класть в атлас, можно ровно потому, что весь
 * текст живёт словарём (UX §8): `charset()` перечисляет их из данных. Шрифт,
 * подмножествованный по языку (PRODUCTION §8), и атлас, собранный по словарю,
 * — одно и то же решение, доведённое до конца.
 */

import { Shape, type ShapeBatch } from './batch';

/**
 * Две гарнитуры и обе обязательны (PRODUCTION §2).
 *
 * Акцидентная говорит голосом заведения и живёт в заголовках; интерфейсная
 * работает и молчит. Смешивать нельзя ни в ту, ни в другую сторону: ар-деко в
 * строке HUD не читается с дивана, гротеск на титуле экрана итогов превращает
 * казино в приборную панель.
 */
export const enum Face {
  /** Акцидентная: титулы экранов, имя Туза, крупные числа итогов. */
  Display = 0,
  /** Интерфейсная: всё остальное — HUD, подписи, реплики. */
  Ui = 1,
}

/** Кегль растрирования. Выше кегля любой надписи в кадре — уменьшать честнее. */
const PX = 64;

/** Поля вокруг глифа в атласе: сглаженный край не имеет права цеплять соседа. */
const PAD = 3;

/** Ширины атласа по возрастанию: берётся первая, в которую влезли все буквы. */
const WIDTHS = [1024, 2048];

/**
 * Потолок стороны текстуры.
 *
 * 2048 — минимум, гарантированный спецификацией WebGL2 на любом устройстве.
 * Просить у драйвера его настоящий предел незачем: атлас, не влезший сюда,
 * означает, что словарь вырос до иероглифов, а их подмножествуют по языку
 * (PRODUCTION §8), а не грузят целиком.
 */
const MAX_SIDE = 2048;

const FONTS: Record<Face, { family: string; weight: number }> = {
  // У акцидентной начертание одно — так её и задумывали.
  [Face.Display]: { family: '"Poiret One"', weight: 400 },
  // Полужирная, а не обычная: HUD читается с двух метров (UX §4), и на тонком
  // начертании кириллица в 24 px рассыпается первой.
  [Face.Ui]: { family: '"Inter"', weight: 600 },
};

/**
 * Шрифт в виде сокращённой записи CSS.
 *
 * Порядок частей обязателен: вес идёт ПЕРЕД кеглем. Запись `64px 600 "Inter"`
 * браузер молча отвергает целиком — шрифт остаётся незагруженным, а атлас
 * собирается подстановочной гарнитурой, и заметно это только глазами.
 */
const cssFont = (face: Face): string => `${FONTS[face].weight} ${PX}px ${FONTS[face].family}`;

interface Glyph {
  /** Прямоугольник в атласе, в долях текстуры. */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Границы отпечатка относительно пера на базовой линии, в долях кегля. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Ширина пробега пера, в долях кегля. */
  advance: number;
}

/**
 * Атлас глифов и укладка строк.
 *
 * До готовности шрифта объект живёт и молчит: `push` ничего не рисует, а
 * `width` возвращает ноль. Ждать шрифта первым кадром нельзя — игра начинается
 * раньше, чем браузер разберёт woff2, и кадр с пустым HUD честнее кадра,
 * которого нет.
 */
export class TextAtlas {
  private readonly glyphs: Map<string, Glyph>[] = [new Map(), new Map()];
  /** Полувысота прописной в долях кегля: по ней строка центрируется. */
  private readonly cap = [0.7, 0.7];
  private texture: WebGLTexture | null = null;
  ready = false;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly batch: ShapeBatch,
  ) {}

  /**
   * Собрать атлас под перечисленные знаки.
   *
   * Сбой здесь не имеет права ронять игру: не собрался атлас — игра остаётся
   * без подписей, но с боем. Обратный порядок («нет шрифта — нет игры») делает
   * из украшения критическую зависимость.
   */
  async load(chars: string): Promise<void> {
    try {
      await this.build(chars);
    } catch {
      // Шрифт не приехал — игра остаётся без подписей, но с боем. Обратный
      // порядок делает из типографики критическую зависимость, а она ею не
      // является: до F2 игра жила вовсе без букв.
    }
  }

  private async build(chars: string): Promise<void> {
    const faces = [Face.Display, Face.Ui] as const;
    // Загрузку заказываем ровно теми знаками, которые собираемся растрировать:
    // браузер подтянет только нужные подмножества woff2, а не оба сразу.
    await Promise.all(faces.map((f) => document.fonts.load(cssFont(f), chars)));

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    if (!ctx) return;

    for (const width of WIDTHS) {
      if (this.layout(ctx, canvas, width, chars)) break;
    }
    if (!this.ready) return;

    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) return;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    // Билинейная фильтрация и никаких мип-уровней: текст уменьшается не больше
    // чем вчетверо, а мипы съели бы тонкие штрихи акцидентной гарнитуры.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.texture = texture;
    this.batch.setAtlas(texture);
  }

  /** Ширина строки в единицах арены: по ней центрируют и проверяют переполнение. */
  width(text: string, size: number, face: Face): number {
    if (!this.ready) return 0;
    const table = this.glyphs[face];
    let sum = 0;
    for (const ch of text) sum += table.get(ch)?.advance ?? 0;
    return sum * size;
  }

  /**
   * Уложить строку в батч.
   *
   * `y` — оптическая середина строки, а не базовая линия: все остальные
   * рисовалки в кадре центрируют по вертикали, и базовая линия здесь означала
   * бы, что подпись рядом с шестиугольником каждый раз двигается вручную.
   *
   * `align` слева или по центру — двух хватает: справа в этом интерфейсе
   * ничего не выравнивается, а лишний случай надо было бы проверять глазами.
   */
  push(
    text: string,
    x: number,
    y: number,
    size: number,
    face: Face,
    r: number,
    g: number,
    b: number,
    a = 1,
    align: 'left' | 'center' = 'left',
  ): void {
    if (!this.ready || text === '') return;
    const table = this.glyphs[face];
    let pen = align === 'center' ? x - this.width(text, size, face) / 2 : x;
    const baseline = y + this.cap[face] * size * 0.5;

    for (const ch of text) {
      const glyph = table.get(ch);
      if (!glyph) continue;
      const advance = glyph.advance * size;
      // Пробел и прочие пустые: перо идёт, инстанс не тратится.
      if (glyph.u1 > glyph.u0) {
        this.batch.push(
          Shape.Glyph,
          pen + ((glyph.x0 + glyph.x1) / 2) * size,
          baseline + ((glyph.y0 + glyph.y1) / 2) * size,
          ((glyph.x1 - glyph.x0) / 2) * size,
          ((glyph.y1 - glyph.y0) / 2) * size,
          0,
          r,
          g,
          b,
          a,
          0,
          0,
          0,
          0,
          0,
          glyph.u0,
          glyph.v0,
          glyph.u1,
          glyph.v1,
        );
      }
      pen += advance;
    }
  }

  /**
   * Разложить знаки по строкам атласа заданной ширины.
   *
   * Возвращает `false`, если не влезли: вызывающий берёт следующую ширину.
   * Простая построчная укладка, а не упаковка прямоугольников, — знаков около
   * трёх сотен, и экономия текстурной памяти тут не окупает ни строчки кода.
   */
  private layout(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    width: number,
    chars: string,
  ): boolean {
    interface Cell {
      face: Face;
      ch: string;
      x: number;
      y: number;
      w: number;
      h: number;
      left: number;
      ascent: number;
      descent: number;
      advance: number;
    }

    const cells: Cell[] = [];
    let penX = 0;
    let penY = 0;
    let rowH = 0;

    for (const face of [Face.Display, Face.Ui] as const) {
      ctx.font = cssFont(face);
      for (const ch of chars) {
        const m = ctx.measureText(ch);
        const left = m.actualBoundingBoxLeft;
        const right = m.actualBoundingBoxRight;
        const ascent = m.actualBoundingBoxAscent;
        const descent = m.actualBoundingBoxDescent;
        const w = Math.ceil(left + right) + PAD * 2;
        const h = Math.ceil(ascent + descent) + PAD * 2;
        if (penX + w > width) {
          penX = 0;
          penY += rowH;
          rowH = 0;
        }
        cells.push({ face, ch, x: penX, y: penY, w, h, left, ascent, descent, advance: m.width });
        penX += w;
        rowH = Math.max(rowH, h);
      }
    }

    const height = penY + rowH;
    if (height > MAX_SIDE) return false;

    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    /*
     * Цвет заливки не задаётся вовсе, и это не забывчивость.
     *
     * Шейдер читает из атласа ТОЛЬКО альфу: цвет буквы приходит инстансом из
     * палитры, иначе перекраска HUD под дальтоника требовала бы пересобрать
     * текстуру. Значит, чем нарисован отпечаток, безразлично — и заводить ради
     * этого цвет мимо палитры (PRODUCTION §8) не за что.
     */

    for (const face of [Face.Display, Face.Ui] as const) this.glyphs[face].clear();

    let font = '';
    for (const cell of cells) {
      const want = cssFont(cell.face);
      if (font !== want) {
        ctx.font = want;
        font = want;
      }
      ctx.fillText(cell.ch, cell.x + PAD + cell.left, cell.y + PAD + cell.ascent);
      this.glyphs[cell.face].set(cell.ch, {
        u0: cell.x / width,
        v0: cell.y / height,
        u1: (cell.x + cell.w) / width,
        v1: (cell.y + cell.h) / height,
        x0: (-cell.left - PAD) / PX,
        x1: (cell.w - PAD - cell.left) / PX,
        y0: (-cell.ascent - PAD) / PX,
        y1: (cell.descent + PAD) / PX,
        advance: cell.advance / PX,
      });
    }

    for (const face of [Face.Display, Face.Ui] as const) {
      /*
       * Высота прописной — по латинской «H» и нулю, а не по буквам языка.
       *
       * Обе обязаны быть в атласе на любом языке: цифры кладёт `charset()`
       * отдельно от словаря, а «H» есть в любой сборке. Мерить кириллицей
       * значило бы центрировать строку по-разному в русской и английской
       * сборке — одна и та же подпись стояла бы на разной высоте.
       */
      const h = Math.max(this.inkAscent(face, 'H'), this.inkAscent(face, '0'));
      if (h > 0) this.cap[face] = h;
    }

    this.ready = true;
    return true;
  }

  /** Высота отпечатка знака над базовой линией, в долях кегля. */
  private inkAscent(face: Face, ch: string): number {
    const g = this.glyphs[face].get(ch);
    return g ? -g.y0 - PAD / PX : 0;
  }

  /** Освободить текстуру: атлас переживает смену языка, но не смену контекста. */
  dispose(): void {
    if (this.texture) this.gl.deleteTexture(this.texture);
    this.texture = null;
    this.ready = false;
  }
}
