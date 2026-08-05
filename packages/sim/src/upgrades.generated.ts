/**
 * СГЕНЕРИРОВАННЫЙ ФАЙЛ. Правьте content/upgrades.json и запускайте npm run content.
 *
 * Апгрейды живут данными (TECH §11), а ядро симуляции не читает файлов и не
 * имеет зависимостей — поэтому каталог приезжает сюда генератором. Расхождение
 * источника и этого файла ловит CI.
 */

/** Что именно меняет апгрейд. Номер значения — позиция в списке эффектов. */
export const enum UpgradeEffect {
  Damage = 0,
  Heart = 1,
  DashCooldown = 2,
  Magnet = 3,
  Drop = 4,
  Speed = 5,
}

/**
 * Номер апгрейда в каталоге.
 *
 * Он же уезжает в слоты купленного (`pUpgrades`) со сдвигом на единицу: ноль
 * там означает пустой слот, иначе первый апгрейд каталога оказался бы у всех
 * и всегда.
 */
export const enum UpgradeId {
  DamageUp = 0,
  ExtraHeart = 1,
  DashCooldown = 2,
  Magnet = 3,
  DropUp = 4,
  SpeedUp = 5,
}

export interface UpgradeSpec {
  readonly id: string;
  readonly name: string;
  /** Базовая цена первого этажа. Цена этажа F — `база × 1.5^(F−1)`. */
  readonly base: number;
  readonly effect: UpgradeEffect;
  /** Величина эффекта: процент или единицы арены, смысл задаёт `effect`. */
  readonly value: number;
}

export const UPGRADES: readonly UpgradeSpec[] = [
  {
    id: 'damage_up',
    name: 'Урон +25%',
    base: 60,
    effect: UpgradeEffect.Damage,
    value: 125,
  },
  {
    id: 'extra_heart',
    name: '+1 сердце',
    base: 55,
    effect: UpgradeEffect.Heart,
    value: 1,
  },
  {
    id: 'dash_cooldown',
    name: 'Кулдаун рывка −30%',
    base: 45,
    effect: UpgradeEffect.DashCooldown,
    value: 70,
  },
  {
    id: 'magnet',
    name: 'Магнит',
    base: 40,
    effect: UpgradeEffect.Magnet,
    value: 250,
  },
  {
    id: 'drop_up',
    name: 'Дроп +50%',
    base: 40,
    effect: UpgradeEffect.Drop,
    value: 150,
  },
  {
    id: 'speed_up',
    name: 'Скорость +15%',
    base: 30,
    effect: UpgradeEffect.Speed,
    value: 115,
  },
];

export const UPGRADE_COUNT = UPGRADES.length;
