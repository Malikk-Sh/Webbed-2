import { PALETTE, mixColor, shade } from '../../app/Palette';
import { surfaceAttachmentConfig } from '../../app/GameConfig';
import { clamp, clamp01, damp, easeOutCubic, wobble } from '../../core/math/Interpolation';
import type { Vector2 } from '../../core/math/Vector2';
import type { Painter } from '../../engine/Painter';
import { textures } from '../../engine/TextureStore';
import type { CollisionWorld } from '../physics/CollisionWorld';
import { TEXTURES } from '../render/TextureFactory';
import type { SpiderController } from './SpiderController';
import type { SpiderMood } from './SpiderState';

interface Leg {
  /** Крепление к головогруди в локальных координатах. */
  hip: Vector2;
  /** Желаемое положение стопы в локальных координатах. */
  rest: Vector2;
  /** Текущее положение стопы в мировых координатах. */
  foot: Vector2;
  stepFrom: Vector2;
  stepTo: Vector2;
  stepProgress: number;
  stepping: boolean;
  /** +1 — ближняя к камере сторона, −1 — дальняя. */
  side: 1 | -1;
  /** Фазовая группа походки. */
  group: 0 | 1;
  femur: number;
  tibia: number;
  planted: boolean;
  initialised: boolean;
}

const LEGS_PER_SIDE = 4;

/** Насколько далеко вниз ищется поверхность для тени в полёте. */
const SHADOW_CAST_RANGE = 520;

/**
 * Процедурная отрисовка Люмы.
 *
 * Локальная система координат: `+X` — вперёд по направлению взгляда,
 * `−Y` — прочь от поверхности. Тело задано в этой системе один раз и просто
 * поворачивается вместе с опорной нормалью, поэтому одна и та же анатомия
 * одинаково правильно читается на полу, на стене и на потолке.
 *
 * Восемь ног не имеют коллайдеров (раздел 10.2 ТЗ): стопы ищут опору
 * запросом к геометрии, переставляются шагами по дуге, а двухзвенная
 * обратная кинематика доводит колено.
 */
export class SpiderVisual {
  private readonly legs: Leg[] = [];

  private gaitPhase = 0;
  private breath = 0;
  private blinkTimer = 2.4;
  private blink = 0;
  private lookTarget: Vector2 = { x: 1, y: 0 };
  private smoothedLook: Vector2 = { x: 1, y: 0 };
  private spinneretGlow = 0;
  private mood: SpiderMood = 'calm';
  private moodEnergy = 0;
  private legDetail = 8;
  /** Была ли героиня на поверхности в прошлом кадре — ловит момент касания. */
  private wasAttached = false;
  /** Плавный разворот корпуса влево-вправо: −1 … +1. */
  private facingBlend = 1;

  constructor(
    private readonly controller: SpiderController,
    private readonly collision: CollisionWorld,
  ) {
    const surfaceY = surfaceAttachmentConfig.targetDistance + 1;
    for (const side of [-1, 1] as const) {
      for (let i = 0; i < LEGS_PER_SIDE; i++) {
        // Ноги расставлены веером от передней к задней. Передняя пара длиннее
        // и вынесена вперёд — по ней силуэт читается даже в мелком масштабе.
        const hipX = 4 - i * 2.6;
        const restX = 23 - i * 12.5;
        const reach = i === 0 ? 4 : i === 3 ? 2 : 0;
        this.legs.push({
          hip: { x: hipX, y: -1 + side * 0.6 },
          rest: { x: restX, y: surfaceY },
          foot: { x: 0, y: 0 },
          stepFrom: { x: 0, y: 0 },
          stepTo: { x: 0, y: 0 },
          stepProgress: 1,
          stepping: false,
          side,
          group: ((i + (side > 0 ? 0 : 1)) % 2) as 0 | 1,
          // Короткое бедро и длинная голень поднимают колено выше корпуса —
          // именно эта арка и читается как «паучья» нога. Равные звенья
          // давали горизонтальный сустав и краб.
          femur: 14 + reach * 0.4,
          tibia: 28 + reach,
          planted: false,
          initialised: false,
        });
      }
    }
  }

  setQuality(legDetail: number): void {
    this.legDetail = clamp(legDetail, 4, 8);
  }

  setMood(mood: SpiderMood): void {
    this.mood = mood;
  }

  flashSpinneret(): void {
    this.spinneretGlow = 1;
  }

  lookAt(direction: Vector2): void {
    const len = Math.hypot(direction.x, direction.y);
    if (len > 0.01) {
      this.lookTarget.x = direction.x / len;
      this.lookTarget.y = direction.y / len;
    }
  }

  update(deltaSeconds: number): void {
    const controller = this.controller;
    const position = controller.position;
    const angle = controller.visualAngle;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    const speed = controller.speed;
    this.gaitPhase += (speed / 60) * deltaSeconds * 1.9;
    this.breath += deltaSeconds * (1.4 + speed / 420);
    this.spinneretGlow = damp(this.spinneretGlow, 0, 0.16, deltaSeconds);
    this.facingBlend = damp(this.facingBlend, controller.facing, 0.07, deltaSeconds);

    this.smoothedLook.x = damp(this.smoothedLook.x, this.lookTarget.x, 0.1, deltaSeconds);
    this.smoothedLook.y = damp(this.smoothedLook.y, this.lookTarget.y, 0.1, deltaSeconds);

    this.blinkTimer -= deltaSeconds;
    if (this.blinkTimer <= 0) {
      this.blinkTimer = 2.2 + Math.random() * 3.4;
      this.blink = 1;
    }
    this.blink = Math.max(0, this.blink - deltaSeconds * 7);

    const targetEnergy =
      this.mood === 'scared' || this.mood === 'hurt' ? 1 : this.mood === 'strained' ? 0.6 : 0;
    this.moodEnergy = damp(this.moodEnergy, targetEnergy, 0.18, deltaSeconds);

    // Разворот выполняется сжатием по X: корпус на мгновение «худеет»,
    // проходя через профиль, — приём классической рисованной анимации.
    const flip = this.facingBlend;
    const toWorld = (local: Vector2): Vector2 => {
      const lx = local.x * flip;
      const ly = local.y;
      return {
        x: position.x + lx * cos - ly * sin,
        y: position.y + lx * sin + ly * cos,
      };
    };

    this.updateLegs(deltaSeconds, toWorld, speed);
  }

  /**
   * Отрисовка. Порядок повторяет прежнюю раскладку по глубине: тень под
   * телом на умножении, мягкий ореол на сложении, само тело, свечение глаз.
   */
  draw(painter: Painter, time: number): void {
    const controller = this.controller;
    const position = controller.position;
    const angle = controller.visualAngle;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const flip = this.facingBlend;
    const toWorld = (local: Vector2): Vector2 => {
      const lx = local.x * flip;
      const ly = local.y;
      return {
        x: position.x + lx * cos - ly * sin,
        y: position.y + lx * sin + ly * cos,
      };
    };

    const soft = textures.get(TEXTURES.glowSoft);

    // Тень ложится на саму поверхность и вытянута вдоль неё.
    const contact = controller.contact;
    if (contact && controller.attached) {
      const shadow = textures.tint(TEXTURES.glowSoft, 0x141d26);
      painter.setBlendMode('multiply');
      painter.drawTexture(
        shadow.canvas,
        contact.point.x,
        contact.point.y,
        shadow.width * 0.28,
        shadow.height * 0.12,
        angle,
        0.45,
      );
    } else {
      // В воздухе тень падает вниз на первую же поверхность под героиней.
      // Без неё в полёте и на дуге маятника нечем измерить высоту: силуэт
      // висит в пустоте, и до земли на глаз может быть и сто единиц, и
      // тысяча.
      const drop = this.collision.raycast(position, {
        x: position.x,
        y: position.y + SHADOW_CAST_RANGE,
      });
      if (drop) {
        const fall = Math.max(0, drop.point.y - position.y);
        const closeness = 1 - fall / SHADOW_CAST_RANGE;
        const shadow = textures.tint(TEXTURES.glowSoft, 0x141d26);
        painter.setBlendMode('multiply');
        painter.drawTexture(
          shadow.canvas,
          drop.point.x,
          drop.point.y,
          shadow.width * (0.2 + (1 - closeness) * 0.22),
          shadow.height * (0.09 + (1 - closeness) * 0.05),
          0,
          // Затухание линейное, а не квадратичное: на тёмном полу тень в
          // режиме умножения и без того еле различима, и квадрат гасил её
          // задолго до того, как она переставала быть нужной.
          0.5 * closeness,
        );
      }
    }

    const halo = textures.tint(TEXTURES.glowSoft, PALETTE.spiderEyeGlow);
    painter.setBlendMode('add');
    painter.drawTexture(
      halo.canvas,
      position.x,
      position.y,
      soft.width * 0.5,
      soft.height * 0.5,
      0,
      0.1 + this.spinneretGlow * 0.2,
    );
    painter.setBlendMode('normal');

    const eyeCentre = this.drawBody(painter, position, angle, cos, sin, flip, toWorld);

    const eye = textures.tint(TEXTURES.glow, PALETTE.spiderEye);
    const openness = clamp01(1 - this.blink) * (1 - this.moodEnergy * 0.3);
    const pulse = 0.4 + Math.sin(time / 620) * 0.05 + this.spinneretGlow * 0.2;
    const eyeSize = eye.width * (0.24 + this.moodEnergy * 0.05);
    painter.setBlendMode('add');
    painter.drawTexture(
      eye.canvas,
      eyeCentre.x,
      eyeCentre.y,
      eyeSize,
      eyeSize,
      0,
      Math.max(0, pulse * openness),
    );
    painter.setBlendMode('normal');
  }

  // ------------------------------------------------------------------- ноги

  private updateLegs(
    deltaSeconds: number,
    toWorld: (local: Vector2) => Vector2,
    speed: number,
  ): void {
    const attached = this.controller.attached;
    if (!attached) {
      this.wasAttached = false;
      this.tuckLegs(deltaSeconds, toWorld);
      return;
    }

    // Касание после полёта: лапы поджаты у тела, а опора уже под ними. Без
    // отдельной обработки четыре ноги уходят в шаг, а остальные просто
    // подтягиваются по прямой — получается рывок, который и видно при
    // приземлении с прыжка. Здесь все восемь начинают шаг разом, но двумя
    // группами со сдвигом: лапы ставятся по дуге и вразнобой, как при
    // настоящем приземлении.
    if (!this.wasAttached) {
      for (const leg of this.legs) {
        if (!leg.initialised) continue;
        leg.stepping = true;
        leg.stepProgress = leg.group === 0 ? 0 : -0.45;
        leg.stepFrom.x = leg.foot.x;
        leg.stepFrom.y = leg.foot.y;
      }
    }
    this.wasAttached = true;

    const stepDuration = clamp(0.19 - speed / 4200, 0.07, 0.19);
    let steppingCount = 0;
    for (const leg of this.legs) if (leg.stepping) steppingCount++;


    for (const leg of this.legs) {
      const maxReach = (leg.femur + leg.tibia) * 0.94;

      const sway = Math.sin(this.gaitPhase * Math.PI + leg.group * Math.PI) * 3.4;
      let desiredWorld = toWorld({ x: leg.rest.x + sway, y: leg.rest.y });

      // Реальная опора: стопа садится на ближайшую поверхность, поэтому на
      // краю платформы нога не висит в воздухе, а цепляется за кромку.
      const query = this.collision.queryClosest(
        desiredWorld,
        30,
        (surface) => surface.material.spiderWalkable,
      );
      if (query) {
        desiredWorld = {
          x: query.point.x + query.normal.x * 1.5,
          y: query.point.y + query.normal.y * 1.5,
        };
      }

      const hip = toWorld(leg.hip);

      if (!leg.initialised) {
        leg.foot.x = desiredWorld.x;
        leg.foot.y = desiredWorld.y;
        leg.initialised = true;
        continue;
      }

      if (!leg.stepping) {
        const dx = desiredWorld.x - leg.foot.x;
        const dy = desiredWorld.y - leg.foot.y;
        const error = Math.hypot(dx, dy);
        const stretched = Math.hypot(leg.foot.x - hip.x, leg.foot.y - hip.y);

        // Порог зависит от фазовой группы — ноги переставляются вразнобой,
        // как при чередующейся четвероногой походке. Растянутая нога
        // переставляется вне очереди: иначе на разгоне она безнадёжно отстаёт.
        const threshold = leg.group === 0 ? 14 : 21;
        const mustStep = stretched > maxReach * 0.86;

        if (error > threshold && (steppingCount < 4 || mustStep)) {
          leg.stepping = true;
          leg.stepProgress = 0;
          leg.stepFrom.x = leg.foot.x;
          leg.stepFrom.y = leg.foot.y;
          steppingCount++;
        } else if (error > 0.5) {
          // Затухание за время, а не за кадр: при просадке частоты стопа
          // догоняет цель ровно так же, как при полных 60 кадрах.
          const follow = 1 - Math.exp(-14 * deltaSeconds);
          leg.foot.x += dx * follow;
          leg.foot.y += dy * follow;
        }
      }

      if (leg.stepping) {
        leg.stepProgress = Math.min(1, leg.stepProgress + deltaSeconds / stepDuration);
        leg.stepTo.x = desiredWorld.x;
        leg.stepTo.y = desiredWorld.y;

        // Отрицательный прогресс — пауза перед переносом: так вторая группа
        // ног при приземлении трогается позже первой. Выходить отсюда по
        // `continue` нельзя: ниже стоит ограничение вылета, и без него
        // отставшая стопа рисуется через полэкрана.
        if (leg.stepProgress >= 0) {
          const t = easeOutCubic(leg.stepProgress);
          const dx = leg.stepTo.x - leg.stepFrom.x;
          const dy = leg.stepTo.y - leg.stepFrom.y;
          const len = Math.hypot(dx, dy) || 1;
          // Подъём по дуге: нога переносится над поверхностью, а не скользит.
          const lift = Math.sin(Math.PI * leg.stepProgress) * 8;
          leg.foot.x = leg.stepFrom.x + dx * t - (dy / len) * lift;
          leg.foot.y = leg.stepFrom.y + dy * t + (dx / len) * lift;

          if (leg.stepProgress >= 1) {
            leg.stepping = false;
            leg.foot.x = leg.stepTo.x;
            leg.foot.y = leg.stepTo.y;
          }
        }
      }

      this.clampReach(leg, hip, maxReach);
      leg.planted = !leg.stepping;
    }
  }

  /**
   * Поза в полёте: ноги поджимаются к телу и мягко подрагивают.
   *
   * Здесь принципиально нет шагового цикла. Раньше в воздухе работал тот же
   * код, что и на поверхности, только с отключённым лимитом одновременных
   * шагов — а цель стопы при этом висела на ускоряющемся теле. Каждый кадр
   * ошибка снова превышала порог, шаг перезапускался с нуля, и все восемь ног
   * мелко и резко дёргались всё падение. Опоры в воздухе нет, переставлять
   * ноги не по чему, поэтому поза просто плавно притягивается к поджатой.
   */
  private tuckLegs(deltaSeconds: number, toWorld: (local: Vector2) => Vector2): void {
    // Затухание за время, а не за кадр: при просадке частоты поза догоняет
    // тело ровно так же, как при полных 60 кадрах.
    const follow = 1 - Math.exp(-14 * deltaSeconds);

    for (const leg of this.legs) {
      const curl = wobble(this.breath * 2.4 + leg.hip.x, leg.side) * 2.2;
      const target = toWorld({ x: leg.rest.x * 0.62, y: leg.rest.y * 0.42 + curl });

      if (!leg.initialised) {
        leg.foot.x = target.x;
        leg.foot.y = target.y;
        leg.initialised = true;
      } else {
        leg.foot.x += (target.x - leg.foot.x) * follow;
        leg.foot.y += (target.y - leg.foot.y) * follow;
      }

      leg.stepping = false;
      leg.stepProgress = 1;
      leg.planted = false;
      this.clampReach(leg, toWorld(leg.hip), (leg.femur + leg.tibia) * 0.94);
    }
  }

  /**
   * Жёсткое ограничение вылета: нога не может быть длиннее суммы своих
   * звеньев. Без него на разгоне отставшая стопа рисуется через полэкрана.
   */
  private clampReach(leg: Leg, hip: Vector2, maxReach: number): void {
    const ox = leg.foot.x - hip.x;
    const oy = leg.foot.y - hip.y;
    const distance = Math.hypot(ox, oy);
    if (distance <= maxReach) return;
    const scale = maxReach / distance;
    leg.foot.x = hip.x + ox * scale;
    leg.foot.y = hip.y + oy * scale;
  }

  /**
   * Двухзвенная обратная кинематика: положение колена по бедру и стопе.
   * `bend` выбирает сторону изгиба сустава.
   */
  private solveKnee(
    hip: Vector2,
    foot: Vector2,
    femur: number,
    tibia: number,
    bend: number,
  ): Vector2 {
    const dx = foot.x - hip.x;
    const dy = foot.y - hip.y;
    const rawDistance = Math.hypot(dx, dy);
    if (rawDistance < 1e-4) return { x: hip.x, y: hip.y - femur };

    const nx = dx / rawDistance;
    const ny = dy / rawDistance;
    // Нога никогда не выпрямляется в струну — остаётся живой изгиб.
    const distance = Math.min(rawDistance, (femur + tibia) * 0.97);

    const a = (femur * femur - tibia * tibia + distance * distance) / (2 * distance);
    const h = Math.sqrt(Math.max(0, femur * femur - a * a));

    return {
      x: hip.x + nx * a - ny * h * bend,
      y: hip.y + ny * a + nx * h * bend,
    };
  }

  // --------------------------------------------------------------- рисование

  /** Возвращает мировую точку, вокруг которой светятся глаза. */
  private drawBody(
    g: Painter,
    position: Vector2,
    angle: number,
    cos: number,
    sin: number,
    flip: number,
    toWorld: (local: Vector2) => Vector2,
  ): Vector2 {
    const squash = this.controller.landingSquash;
    // Приземление сплющивает по нормали и растягивает вдоль поверхности.
    const scaleAlong = 1 + squash * 0.24;
    const scaleNormal = 1 - squash * 0.3;
    const bob = Math.sin(this.gaitPhase * Math.PI * 2) * (this.controller.attached ? 0.9 : 0);
    const breathe = 1 + Math.sin(this.breath) * 0.03;

    const body = (x: number, y: number): Vector2 => {
      const lx = x * flip * scaleAlong;
      const ly = y * scaleNormal + bob;
      return {
        x: position.x + lx * cos - ly * sin,
        y: position.y + lx * sin + ly * cos,
      };
    };

    // --- дальние ноги ---------------------------------------------------
    for (const leg of this.legs) {
      if (leg.side === 1) continue;
      this.drawLeg(g, leg, toWorld, 0.55);
    }

    // --- брюшко ---------------------------------------------------------
    this.fillEllipse(g, body(-10.5, 0.5), 12.6 * breathe, 10.8 * breathe, angle, PALETTE.spiderBody);
    this.fillEllipse(
      g,
      body(-11.5, -2.2),
      9.4 * breathe,
      7.2 * breathe,
      angle,
      shade(PALETTE.spiderBodyLight, -0.08),
    );
    // Тёплая метка на брюшке — узнаваемая деталь силуэта.
    g.fillStyle(PALETTE.spiderMark, 0.8);
    for (const [x, y, r] of [
      [-8.5, -1.5, 2.6],
      [-12.5, -0.6, 1.9],
      [-16, 0.4, 1.1],
    ] as const) {
      const point = body(x, y);
      g.fillCircle(point.x, point.y, r);
    }

    const spinneret = body(-21, 2.4);
    g.fillStyle(shade(PALETTE.spiderBody, -0.25), 1);
    g.fillCircle(spinneret.x, spinneret.y, 2.6);

    // --- перемычка и головогрудь ----------------------------------------
    this.fillEllipse(g, body(-1.5, 0.4), 4.6, 4.2, angle, shade(PALETTE.spiderBody, -0.12));
    this.fillEllipse(g, body(4.5, -0.6), 8.8, 7.4, angle, shade(PALETTE.spiderBody, 0.1));
    this.fillEllipse(g, body(5.6, -2.6), 6.2, 4.6, angle, PALETTE.spiderBodyLight);

    // --- ближние ноги ---------------------------------------------------
    for (const leg of this.legs) {
      if (leg.side === -1) continue;
      this.drawLeg(g, leg, toWorld, 1);
    }

    // --- педипальпы -------------------------------------------------------
    g.lineStyle(2.2, shade(PALETTE.spiderLegLight, -0.1), 0.9);
    for (const side of [-1, 1]) {
      const base = body(9, -1 + side * 1.6);
      const mid = body(13.5 + Math.sin(this.breath * 2.2 + side) * 0.8, 1 + side * 1.4);
      const tip = body(16.5 + Math.sin(this.breath * 2.2 + side) * 1.2, 4.5 + side * 1.2);
      g.beginPath();
      g.moveTo(base.x, base.y);
      g.lineTo(mid.x, mid.y);
      g.lineTo(tip.x, tip.y);
      g.strokePath();
    }

    const eyeCentre = this.drawEyes(g, body, cos, sin, flip);

    if (this.spinneretGlow > 0.01) {
      g.fillStyle(PALETTE.silkGlow, this.spinneretGlow * 0.9);
      g.fillCircle(spinneret.x, spinneret.y, 2 + this.spinneretGlow * 2.8);
    }

    return eyeCentre;
  }

  private drawLeg(
    g: Painter,
    leg: Leg,
    toWorld: (local: Vector2) => Vector2,
    depthFactor: number,
  ): void {
    const hip = toWorld(leg.hip);
    // Колено «домиком» — характерная поза паука: передние ноги выгибаются
    // вперёд, задние назад, поэтому знак зависит от места на теле.
    const bend = (leg.rest.x >= 0 ? -1 : 1) * (this.facingBlend >= 0 ? 1 : -1);
    const knee = this.solveKnee(hip, leg.foot, leg.femur, leg.tibia, bend);

    const color = mixColor(PALETTE.spiderLeg, PALETTE.spiderLegLight, depthFactor);
    const alpha = 0.62 + depthFactor * 0.38;

    // Голень строится тремя отрезками с сужением — она заметно длиннее
    // бедра, и постоянная толщина сделала бы её похожей на палку.
    g.lineStyle(3.4 * depthFactor + 0.6, color, alpha);
    g.beginPath();
    g.moveTo(hip.x, hip.y);
    g.lineTo(knee.x, knee.y);
    g.strokePath();

    const midX = knee.x + (leg.foot.x - knee.x) * 0.55;
    const midY = knee.y + (leg.foot.y - knee.y) * 0.55;
    g.lineStyle(2.5 * depthFactor + 0.4, color, alpha);
    g.beginPath();
    g.moveTo(knee.x, knee.y);
    g.lineTo(midX, midY);
    g.strokePath();
    g.lineStyle(1.5 * depthFactor + 0.3, color, alpha);
    g.beginPath();
    g.moveTo(midX, midY);
    g.lineTo(leg.foot.x, leg.foot.y);
    g.strokePath();

    if (this.legDetail >= 6) {
      g.fillStyle(shade(color, 0.25), alpha);
      g.fillCircle(knee.x, knee.y, 1.5 * depthFactor + 0.4);
      // Коготок: короткий штрих на конце опорной ноги.
      if (leg.planted) {
        const dx = leg.foot.x - knee.x;
        const dy = leg.foot.y - knee.y;
        const len = Math.hypot(dx, dy) || 1;
        g.lineStyle(1.6 * depthFactor, shade(color, 0.3), alpha);
        g.beginPath();
        g.moveTo(leg.foot.x, leg.foot.y);
        g.lineTo(leg.foot.x + (dx / len) * 2.4, leg.foot.y + (dy / len) * 2.4);
        g.strokePath();
      }
    }
  }

  private drawEyes(
    g: Painter,
    body: (x: number, y: number) => Vector2,
    cos: number,
    sin: number,
    flip: number,
  ): Vector2 {
    // Взгляд переводится в локальные координаты, чтобы глаза следили за
    // целью, а не за экраном, на любой поверхности.
    const facingSign = flip >= 0 ? 1 : -1;
    const lookLocalX = (this.smoothedLook.x * cos + this.smoothedLook.y * sin) * facingSign;
    const lookLocalY = -this.smoothedLook.x * sin + this.smoothedLook.y * cos;
    const pupilX = clamp(lookLocalX, -1, 1) * 1.4;
    const pupilY = clamp(lookLocalY, -1, 1) * 1.1;

    const openness = clamp01(1 - this.blink) * (1 - this.moodEnergy * 0.3);
    const fear = this.moodEnergy;

    // Две крупные передние линзы.
    for (const [x, y, radius] of [
      [9.4, -4.4, 3.4],
      [10.4, -0.9, 2.8],
    ] as const) {
      const centre = body(x, y);
      const r = radius - fear * 0.3;
      g.fillStyle(0x090c12, 0.95);
      g.fillEllipse(centre.x, centre.y, r * 2, r * 2 * Math.max(0.08, openness));
      if (openness > 0.15) {
        const pupil = body(x + pupilX, y + pupilY);
        g.fillStyle(PALETTE.spiderEye, 0.95);
        g.fillEllipse(pupil.x, pupil.y, r * 1.3, r * 1.3 * openness);
        g.fillStyle(0xffffff, 0.9);
        const glint = body(x - 0.8, y - 1);
        g.fillCircle(glint.x, glint.y, r * 0.28);
      }
    }

    // Шесть малых глаз довершают восьмиглазый силуэт.
    if (this.legDetail >= 6) {
      g.fillStyle(PALETTE.spiderEyeGlow, 0.5 * openness + 0.1);
      for (const [x, y] of [
        [6.6, -6.2],
        [4.2, -5.6],
        [7.4, 1.6],
        [4.8, 2.4],
        [11.4, -6.4],
        [2.2, -4.6],
      ] as const) {
        const point = body(x, y);
        g.fillCircle(point.x, point.y, 0.95);
      }
    }

    return body(9.8, -2.6);
  }

  private fillEllipse(
    g: Painter,
    centre: Vector2,
    rx: number,
    ry: number,
    angle: number,
    color: number,
  ): void {
    g.fillStyle(color, 1);
    g.fillEllipseRotated(centre.x, centre.y, rx, ry, angle);
  }

  /** Положения стоп относительно точки, читается браузерными тестами. */
  footOffsets(origin: Vector2): { x: number; y: number }[] {
    return this.legs.map((leg) => ({ x: leg.foot.x - origin.x, y: leg.foot.y - origin.y }));
  }

  /** Точка выхода нити — кончик брюшка. */
  getSpinneretWorld(): Vector2 {
    const position = this.controller.position;
    const angle = this.controller.visualAngle;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const lx = -21 * this.facingBlend;
    const ly = 2.4;
    return {
      x: position.x + lx * cos - ly * sin,
      y: position.y + lx * sin + ly * cos,
    };
  }
}
