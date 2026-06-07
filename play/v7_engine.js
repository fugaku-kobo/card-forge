/* 手塚カードゲーム v7 — ルールエンジン(ブラウザ/Node 両用)
 *
 * sim/v7_sim.py の v7 ルールを忠実移植したもの。攻撃力は3桁(×100)。
 * - フェイズ進行・ページカード30種・急展開カード・リーダー4能力・固有能力・突破得点・勝利判定を再現。
 * - 盾持ち/貫通キーワードを戦闘に実装(sim相当デッキには無いのでバランス回帰は一致する)。
 * - 乱数は seed 可能(Node でのバランス回帰を Python と統計一致させるため)。
 *
 * 既定の貪欲AI(autoMainPhase/chooseBlock 等)は sim と同じヒューリスティック。
 * 人間操作・MCTS は play/v7_ai.js / UI 側がこのエンジンのプリミティブを呼んで実現する。
 */
(function (root) {
  'use strict';

  // ---------------- seedable PRNG (mulberry32) ----------------
  function makeRng(seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    function next() {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    return {
      random: next,
      randint: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), // inclusive
      choice: (arr) => arr[Math.floor(next() * arr.length)],
      shuffle: (arr) => {                       // Fisher–Yates in place
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(next() * (i + 1));
          const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
        }
        return arr;
      },
      sample: (arr, k) => {                      // k distinct, order randomized
        const pool = arr.slice();
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(next() * (i + 1));
          const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
        }
        return pool.slice(0, k);
      },
    };
  }

  // ---------------- 定数 ----------------
  const WIN_GENKO = 4;     // 勝利=異なる名前のキャラ4枚
  const MAX_TURNS = 20;    // ページカード20枚=20ターン
  const FIELD_CAP = 3;
  const TRAP_CAP = 2;

  const DEFAULT_CFG = {
    ribbon_prince: 100,    // サファイア「王子」: 攻撃時 +N
    franz: 200,            // フランツ「白馬の王子」: 心が王子の間 +N
    gin: 100,              // サファイア「銀の騎士」: 心が王子なら +N
    bj_shitto: 200,        // BJ「執刀」救命: 攻撃力 +N
    nagi_revive: 200,      // ナギ「輪廻」: 蘇生キャラ +N(永続)
    iishi_any: false,      // 本間「医の遺志」: true=任意の味方 / false=BJのみ
  };

  // ---------------- 攻撃力計算式(×100) ----------------
  function baseAtk(lv, hasAbility, isStar) {
    let a = lv === 1 ? 200 : 400;
    if (!hasAbility) a += 100;   // 通常変種
    if (isStar) a += 100;        // 主役キャラ
    return a;
  }

  // ---------------- 作品データ: name -> [role, abilityTag] ----------------
  const WORKS = {
    BJ: {
      'ブラック・ジャック': ['star', 'mesu'],
      'ピノコ': ['sub', 'pinoko'],
      '本間丈太郎': ['sub', 'iishi'],
      'ドクター・キリコ': ['sub', 'anraku'],
    },
    ATOM: {
      '鉄腕アトム': ['star', 'horsepower'],
      'ウラン': ['sub', 'uran'],
      'コバルト': ['sub', 'cobalt'],
      'お茶の水博士': ['sub', 'ochanomizu'],
    },
    HINOTORI: {
      '火の鳥': ['star', 'fushicho'],
      'ナギC': ['sub', 'nagi_c'],
      '猿田彦': ['sub', 'sarutahiko'],
      '天弓彦': ['sub', 'amayumihiko'],
    },
    RIBBON: {
      'サファイア': ['star', 'gin'],
      'チンク': ['sub', 'chink'],
      'フランツ王子': ['sub', 'franz'],
      'ヘケート': ['sub', 'hecate'],
    },
  };
  const SPLASH = ['ロック', '写楽'];   // 汎用(能力なし)
  const LEADERS = ['BJ', 'ATOM', 'HINOTORI', 'RIBBON'];
  const LEADER_LABEL = { BJ: 'ブラック・ジャック', ATOM: '鉄腕アトム', HINOTORI: 'ナギ(火の鳥)', RIBBON: 'サファイア' };

  // ---------------- カード生成 ----------------
  function makeChar(name, lv, hasAbility, isStar, ability, opts) {
    opts = opts || {};
    return {
      kind: 'char', name: name, lv: lv,
      has_ability: hasAbility, is_star: isStar,
      ability: hasAbility ? ability : null,
      base: opts.base != null ? opts.base : baseAtk(lv, hasAbility, isStar),
      shield: !!opts.shield,     // 盾持ち
      guardian: !!opts.guardian, // 守り手
      pierce: !!opts.pierce,     // 貫通
    };
  }
  function makeKt(ktid) { return { kind: 'kt', ktid: ktid }; }

  // sim と同一構成の30枚デッキ(バランス回帰用)。
  // opts.pierce: 汎用枠の一部を「貫通」カード(攻撃力500・固有能力なし)に差し替える。
  function buildDeck(work, rng, opts) {
    opts = opts || {};
    const deck = [];
    const entries = Object.entries(WORKS[work]);
    for (const [name, ra] of entries) {
      const star = ra[0] === 'star', tag = ra[1];
      deck.push(makeChar(name, 1, true, star, tag));
      deck.push(makeChar(name, 1, true, star, tag));
      deck.push(makeChar(name, 2, true, star, tag));
      deck.push(makeChar(name, 2, false, star, tag));
    }
    for (const name of SPLASH) {
      deck.push(makeChar(name, 1, false, false, null));
      deck.push(makeChar(name, 1, false, false, null));
      deck.push(makeChar(name, 2, false, false, null));
      deck.push(makeChar(name, 2, false, false, null));
    }
    for (const ktid of ['KT-003', 'KT-003', 'KT-002', 'KT-002', 'KT-005', 'KT-005']) {
      deck.push(makeKt(ktid));
    }
    if (opts.pierce) {
      // 汎用キャラ(SPLASH)の Lv2通常 を2枚抜き、自リーダーの「貫通」カードを投入。
      const starName = entries.find(e => e[1][0] === 'star')[0];
      const subName = entries.find(e => e[1][0] === 'sub')[0];
      let removed = 0;
      for (let i = deck.length - 1; i >= 0 && removed < 2; i--) {
        const c = deck[i];
        if (c.kind === 'char' && SPLASH.includes(c.name) && c.lv === 2) { deck.splice(i, 1); removed++; }
      }
      deck.push(makeChar(starName, 2, false, true, null, { pierce: true, base: 300 }));
      deck.push(makeChar(subName, 2, false, false, null, { pierce: true, base: 300 }));
    }
    if (rng) rng.shuffle(deck);
    return deck;
  }

  const PAGE_POOL = Array.from({ length: 30 }, (_, i) => 'PG-' + String(i + 1).padStart(3, '0'));

  // ---------------- ユニット ----------------
  let _uid = 0;
  function newUnit(card) {
    return {
      uid: ++_uid,
      card: card, cards: [card], sick: true,
      perm: 0, temp: 0, no_botsu: false, locked: false, iishi: false,
      shield_used: false,
    };
  }

  function removeItem(arr, item) {
    const i = arr.indexOf(item);
    if (i >= 0) arr.splice(i, 1);
    return i >= 0;
  }

  // ---------------- プレイヤー ----------------
  class Player {
    constructor(work, rng, deck) {
      this.work = work;
      this.rng = rng;
      this.deck = deck || buildDeck(work, rng);
      this.hand = [];
      this.field = [];
      this.bocchi = [];
      this.exile = [];
      this.genko = [];
      this.traps = [];        // [card, setTurn]
      this.heart = 'prince';
      this.fushicho_used = false;
      for (let i = 0; i < 5; i++) this.hand.push(this.deck.pop());
      // 簡易マリガン: キャラ2枚未満なら1回引き直し
      if (this.hand.filter(c => c.kind === 'char').length < 2) {
        this.deck = this.deck.concat(this.hand);
        rng.shuffle(this.deck);
        this.hand = [];
        for (let i = 0; i < 5; i++) this.hand.push(this.deck.pop());
      }
    }
    draw(n = 1) { for (let i = 0; i < n; i++) if (this.deck.length) this.hand.push(this.deck.pop()); }
    genkoNames() { return new Set(this.genko.map(c => c.name)); }
    hasWon() { return this.genkoNames().size >= WIN_GENKO; }
  }

  // ---------------- ゲーム ----------------
  class Game {
    constructor(workA, workB, rng, cfg, deckOptsA, deckOptsB) {
      this.rng = rng;
      this.cfg = Object.assign({}, DEFAULT_CFG, cfg || {});
      this.players = [
        new Player(workA, rng, buildDeck(workA, rng, deckOptsA)),
        new Player(workB, rng, buildDeck(workB, rng, deckOptsB)),
      ];
      this.works = [workA, workB];
      this.track = rng.sample(PAGE_POOL, MAX_TURNS);
      this.turn = 0;
      this.first = rng.randint(0, 1);
      this.active = 0;
      this.bj_used = false;
      this.log = [];
    }

    // 攻撃力(状況込み)
    effAtk(pi, unit, page, active) {
      const c = unit.card;
      let a = page === 'PG-002' ? 300 : c.base;
      a += unit.perm + unit.temp;
      const ab = c.ability;
      const pl = this.players[pi];
      if (ab === 'horsepower' && pl.field.length >= 3) a += 300;
      if (ab === 'pinoko' && pl.field.some(u => u.card.name === 'ブラック・ジャック')) a += 200;
      if (ab === 'franz' && pl.heart === 'prince') a += this.cfg.franz;
      if (ab === 'gin' && pl.heart === 'prince') a += this.cfg.gin;
      if (page === 'PG-020' && c.lv === 2) a += 200;
      if (page === 'PG-013' && pi === active) a -= 200;
      if (page === 'PG-014' && pi !== active) a -= 200;
      return Math.max(100, a);
    }

    toBocchi(pi, unitOrCard, page) {
      const pl = this.players[pi];
      const cards = unitOrCard.cards ? unitOrCard.cards : [unitOrCard];
      for (const card of cards) {
        if (page === 'PG-012') { pl.exile.push(card); continue; }
        if (card.ability === 'fushicho' && !pl.fushicho_used) {
          pl.fushicho_used = true; pl.hand.push(card); continue;
        }
        if (card.ability === 'nagi_c') pl.draw(1);
        pl.bocchi.push(card);
      }
    }

    triggerEtb(pi, unit, page) {
      const ab = unit.card.ability;
      const pl = this.players[pi];
      const opp = this.players[1 - pi];
      const rng = this.rng;
      if (ab === 'mesu' && opp.field.length) {
        rng.choice(opp.field).temp -= 300;
      } else if (ab === 'iishi') {
        let cand;
        if (this.cfg.iishi_any) {
          const names = pl.genkoNames();
          cand = pl.field.filter(u => !u.iishi && !names.has(u.card.name));
          if (!cand.length) cand = pl.field.filter(u => !u.iishi);
        } else {
          cand = pl.field.filter(u => u.card.name === 'ブラック・ジャック' && !u.iishi);
        }
        if (cand.length) {
          const t = cand.reduce((m, u) => u.card.base > m.card.base ? u : m, cand[0]);
          t.perm += 200; t.iishi = true;
        }
      } else if (ab === 'anraku') {
        const weak = opp.field.filter(u => this.effAtk(1 - pi, u, page, this.active) <= 200);
        if (weak.length) {
          const victim = weak[0];
          removeItem(opp.field, victim);
          this.toBocchi(1 - pi, victim, page);
        }
      } else if (ab === 'uran') {
        for (const u of pl.field) if (u !== unit) u.temp += 100;
      } else if (ab === 'cobalt') {
        if (pl.field.length >= 3) pl.draw(2);
      } else if (ab === 'ochanomizu') {
        pl.draw(1);
      } else if (ab === 'sarutahiko') {
        if (pl.bocchi.some(c => c.kind === 'char' && c.name === '猿田彦')) unit.perm += 200;
      } else if (ab === 'amayumihiko') {
        const l1 = opp.field.filter(u => u.card.lv === 1);
        if (l1.length) {
          const victim = rng.choice(l1);
          removeItem(opp.field, victim);
          for (const card of victim.cards) opp.hand.push(card);
        }
      } else if (ab === 'chink') {
        pl.heart = 'prince';
      } else if (ab === 'hecate' && opp.field.length) {
        rng.choice(opp.field).temp -= 200;
      }
    }

    // ---- メインフェイズ(貪欲AI) ----
    autoMainPhase(pi, page) {
      const pl = this.players[pi];
      // KT-005: 手札が薄ければドロー
      while (pl.hand.length < 4 && this.popTrap(pl, 'KT-005')) pl.draw(2);
      // ナギ「輪廻」
      if (pl.work === 'HINOTORI' && pl.field.length < FIELD_CAP) {
        const revivable = pl.bocchi.filter(c => c.kind === 'char');
        if (revivable.length) {
          const card = revivable.reduce((m, c) => c.base > m.base ? c : m, revivable[0]);
          removeItem(pl.bocchi, card);
          const u = newUnit(card);
          u.perm += this.cfg.nagi_revive;
          pl.field.push(u);
          this.triggerEtb(pi, u, page);
        }
      }
      // 進化
      for (const u of pl.field.slice()) {
        if (u.card.lv === 1) {
          const ev = pl.hand.find(c => c.kind === 'char' && c.name === u.card.name && c.lv === 2);
          if (ev) { removeItem(pl.hand, ev); u.cards.push(ev); u.card = ev; }
        }
      }
      // 召喚(最大3・場3枠)
      let plays = 0;
      while (plays < 3 && pl.field.length < FIELD_CAP) {
        const chars = pl.hand.filter(c => c.kind === 'char');
        if (!chars.length) break;
        const card = chars.reduce((m, c) => {
          const sc = c.base + (c.ability ? 200 : 0);
          const ms = m.base + (m.ability ? 200 : 0);
          return sc > ms ? c : m;
        }, chars[0]);
        removeItem(pl.hand, card);
        const u = newUnit(card);
        pl.field.push(u);
        this.triggerEtb(pi, u, page);
        plays++;
        if (page === 'PG-018') for (let k = 0; k < 2; k++) if (pl.deck.length) this.toBocchi(pi, pl.deck.pop(), page);
      }
      // 急展開セット
      while (pl.traps.length < TRAP_CAP) {
        const kt = pl.hand.find(c => c.kind === 'kt');
        if (!kt) break;
        removeItem(pl.hand, kt);
        pl.traps.push([kt, this.turn]);
      }
    }

    // ---- ブロック選択(貪欲AI) ----
    chooseBlock(defI, atkEff, blockersUsed, page, scoringNew, attacker) {
      const pl = this.players[defI];
      const cands = pl.field.filter(u => !u.locked);
      if (!cands.length) return null;
      if (page === 'PG-024' && blockersUsed >= 1) return null;
      const rev = page === 'PG-001';
      let best = null, bestScore = -99;
      for (const u of cands) {
        // 盾持ち: 確実に止められる最優先択
        if (u.card.shield && !u.shield_used) {
          const sc = 5 - u.card.base * 0.0005;
          if (sc > bestScore) { best = u; bestScore = sc; }
          continue;
        }
        let be = this.effAtk(defI, u, page, this.active);
        if (pl.work === 'RIBBON' && pl.heart === 'princess') be += 200;
        let kills, survives, trade;
        if (!rev) { kills = be > atkEff; survives = be > atkEff; trade = be === atkEff; }
        else { kills = be < atkEff; survives = be < atkEff; trade = be === atkEff; }
        let sc = (kills && survives ? 3 : 0) + (trade ? 2 : 0);
        if (!kills && !trade) sc = scoringNew ? 1 : -5;
        sc -= u.card.base * 0.0005;
        if (sc > bestScore) { best = u; bestScore = sc; }
      }
      return bestScore > -5 ? best : null;
    }

    score(pi, unit, page, unblocked) {
      const pl = this.players[pi];
      const name = unit.card.name;
      if (pl.genkoNames().has(name)) {
        this.toBocchi(pi, unit, page); pl.draw(2); return;
      }
      for (const card of unit.cards) pl.genko.push(card);
      if (unblocked && page === 'PG-030') pl.draw(1);
      if (page === 'PG-016') {
        const names = pl.genkoNames();
        const extra = pl.bocchi.filter(c => c.kind === 'char' && !names.has(c.name));
        if (extra.length) { removeItem(pl.bocchi, extra[0]); pl.genko.push(extra[0]); }
      }
    }

    // ---- バトルフェイズ前処理(KT-002・BJ執刀)→ 攻撃者リストを返す ----
    // 人間/AI 共通。攻撃可能ユニットを攻撃力降順で返す。
    battlePreSteps(pi, page) {
      const atkPl = this.players[pi];
      const defI = 1 - pi;
      const ignoreSick = page === 'PG-023';
      const names = atkPl.genkoNames();
      let attackers = atkPl.field.filter(u =>
        (!u.sick || ignoreSick) && !names.has(u.card.name) && !(u.card.shield && !u.shield_used));
      attackers.sort((x, y) => this.effAtk(pi, y, page, this.active) - this.effAtk(pi, x, page, this.active));
      // KT-002「没ネーム」: 強敵ブロッカー除去
      if (attackers.length && this.players[defI].field.length) {
        const opp = this.players[defI];
        const blk = opp.field.reduce((m, u) => this.effAtk(defI, u, page, this.active) > this.effAtk(defI, m, page, this.active) ? u : m, opp.field[0]);
        const topae = this.effAtk(pi, attackers[0], page, this.active);
        if (this.effAtk(defI, blk, page, this.active) >= topae && this.popTrap(atkPl, 'KT-002')) {
          removeItem(opp.field, blk); this.toBocchi(defI, blk, page);
        }
      }
      // BJ「執刀」
      if (atkPl.work === 'BJ' && !this.bj_used && attackers.length) {
        const best = attackers[0];
        const bae = this.effAtk(pi, best, page, this.active);
        const blks = this.players[defI].field.slice().sort((x, y) =>
          this.effAtk(defI, y, page, this.active) - this.effAtk(defI, x, page, this.active));
        if (blks.length && this.effAtk(defI, blks[0], page, this.active) >= bae + this.cfg.bj_shitto) {
          blks[0].locked = true;
        } else {
          best.temp += this.cfg.bj_shitto; best.no_botsu = true;
        }
        this.bj_used = true;
      }
      return attackers;
    }

    // 攻撃者 u の最終攻撃力を計算(RIBBON王子・KT-003押し込みの副作用込み)。
    computeAttackEff(pi, u, page) {
      const atkPl = this.players[pi];
      const defI = 1 - pi;
      let ae = this.effAtk(pi, u, page, this.active);
      if (atkPl.work === 'RIBBON' && atkPl.heart === 'prince') ae += this.cfg.ribbon_prince;
      if (this.wantsPush(pi, u, ae, defI, page)) {
        if (this.popTrap(atkPl, 'KT-003')) { u.temp += 300; ae += 300; }
      }
      return ae;
    }

    // 1攻撃を解決。blk=null は無ブロック(得点)。
    settleAttack(pi, defI, u, ae, blk, page) {
      if (blk === null) {
        removeItem(this.players[pi].field, u);
        this.score(pi, u, page, true);
      } else {
        this.resolveCombat(pi, defI, u, ae, blk, page);
      }
    }

    // ---- バトルフェイズ(貪欲AI) ----
    // opts.holdBack: 最大攻撃力の1体を攻撃させず壁として温存(MCTS候補手用)。
    autoBattlePhase(pi, page, opts) {
      const atkPl = this.players[pi];
      const defI = 1 - pi;
      let attackers = this.battlePreSteps(pi, page);
      if (opts && opts.holdBack && attackers.length > 1) attackers = attackers.slice(1);
      const maxAtk = page === 'PG-025' ? 1 : 99;
      let done = 0, blockersUsed = 0;
      for (const u of attackers.slice()) {
        if (done >= maxAtk) break;
        if (atkPl.field.indexOf(u) < 0) continue;
        done++;
        const ae = this.computeAttackEff(pi, u, page);
        const blk = this.chooseBlock(defI, ae, blockersUsed, page, true, u);
        if (blk !== null) blockersUsed++;
        this.settleAttack(pi, defI, u, ae, blk, page);
        if (atkPl.hasWon()) return;
      }
    }

    // 攻撃側 u(攻撃力 ae)対 ブロッカー blk の解決
    resolveCombat(pi, defI, u, ae, blk, page) {
      const atkPl = this.players[pi];
      // 盾持ち/守り手による完全ブロック
      if (blk.card.shield && !blk.shield_used) {
        blk.shield_used = true;   // 1回だけ。攻撃側も没にならない・得点なし
        return;
      }
      let be = this.effAtk(defI, blk, page, this.active);
      if (this.players[defI].work === 'RIBBON' && this.players[defI].heart === 'princess') be += 200;
      const rev = page === 'PG-001';
      let atkWin, tie;
      if (page === 'PG-003' || page === 'PG-004') {
        let da = this.rng.randint(1, 6), db = this.rng.randint(1, 6);
        while (da === db) { da = this.rng.randint(1, 6); db = this.rng.randint(1, 6); }
        atkWin = page === 'PG-003' ? da > db : da < db; tie = false;
      } else if (page === 'PG-005') {
        let av = 0, bv = 0;
        if (atkPl.deck.length) { const t = atkPl.deck.pop(); av = t.base || 0; atkPl.bocchi.push(t); }
        if (this.players[defI].deck.length) { const t = this.players[defI].deck.pop(); bv = t.base || 0; this.players[defI].bocchi.push(t); }
        atkWin = av > bv; tie = av === bv;
      } else {
        atkWin = rev ? ae < be : ae > be; tie = ae === be;
      }
      if (tie) {
        if (!u.no_botsu) { removeItem(atkPl.field, u); this.toBocchi(pi, u, page); }
        if (!blk.no_botsu) { removeItem(this.players[defI].field, blk); this.toBocchi(defI, blk, page); }
      } else if (atkWin) {
        if (!blk.no_botsu) { removeItem(this.players[defI].field, blk); this.toBocchi(defI, blk, page); }
        removeItem(atkPl.field, u);
        this.score(pi, u, page, false);
      } else {
        if (!u.no_botsu) { removeItem(atkPl.field, u); this.toBocchi(pi, u, page); }
      }
    }

    popTrap(pl, ktid) {
      for (let i = 0; i < pl.traps.length; i++) {
        const [kt, st] = pl.traps[i];
        if (kt.ktid === ktid && st < this.turn) {
          pl.traps.splice(i, 1); pl.bocchi.push(kt); return kt;
        }
      }
      return null;
    }

    wantsPush(pi, u, ae, defI, page) {
      const opp = this.players[defI];
      for (const b of opp.field) {
        const be = this.effAtk(defI, b, page, this.active);
        if (ae <= be && be < ae + 300) return true;
      }
      return false;
    }

    // ---- リーダー: アトムのダイス ----
    atomDice(pi) {
      const pl = this.players[pi];
      for (let k = 0; k < 3; k++) {
        const r = this.rng.randint(1, 6);
        if (r === 1 && pl.field.length) {
          pl.field.reduce((m, u) => u.card.base > m.card.base ? u : m, pl.field[0]).temp += 400;
        } else if (r === 2) {
          for (const u of pl.field) u.sick = false;
        } else if (r === 3) {
          pl.draw(2);
        } else if (r === 4 && this.players[1 - pi].field.length) {
          this.rng.choice(this.players[1 - pi].field).temp -= 300;
        } else if (r === 5) {
          const chars = pl.bocchi.filter(c => c.kind === 'char');
          if (chars.length) {
            const c = chars.reduce((m, x) => x.base > m.base ? x : m, chars[0]);
            removeItem(pl.bocchi, c); pl.hand.push(c);
          }
        }
        if (r !== 6) break;
      }
    }

    pageStart(pi, page) {
      const pl = this.players[pi], opp = this.players[1 - pi];
      if (page === 'PG-022' && pl.field.length) {
        const top = pl.field.reduce((m, u) => this.effAtk(pi, u, page, this.active) > this.effAtk(pi, m, page, this.active) ? u : m, pl.field[0]);
        top.temp += 300;
      } else if (page === 'PG-007') {
        for (const p of [pl, opp]) if (p.bocchi.length) p.hand.push(p.bocchi.pop());
      } else if (page === 'PG-027') {
        for (const p of [pl, opp]) {
          const chars = p.bocchi.filter(c => c.kind === 'char');
          if (chars.length) { removeItem(p.bocchi, chars[0]); p.hand.push(chars[0]); }
        }
      } else if (page === 'PG-028') {
        pl.draw(2); opp.draw(2);
      }
    }

    pageEnd(pi, page) {
      const pl = this.players[pi], opp = this.players[1 - pi];
      if (page === 'PG-019') {
        pl.bocchi = pl.bocchi.concat(pl.hand); pl.hand = []; pl.draw(5);
      } else if (page === 'PG-026') {
        const a = pl.genkoNames().size, b = opp.genkoNames().size;
        if (a < b) pl.draw(2); else if (b < a) opp.draw(2); else { pl.draw(1); opp.draw(1); }
      } else if (page === 'PG-029') {
        for (const [p, idx] of [[pl, pi], [opp, 1 - pi]]) {
          if (p.field.length) {
            const victim = p.field.reduce((m, u) => u.card.base < m.card.base ? u : m, p.field[0]);
            removeItem(p.field, victim); this.toBocchi(idx, victim, page);
          }
        }
      }
    }

    doDraw(pi, page, skip) {
      const pl = this.players[pi];
      if (skip) return;
      if (page === 'PG-010') {
        if (pl.hand.length) pl.bocchi.push(pl.hand.splice(this.rng.randint(0, pl.hand.length - 1), 1)[0]);
        else if (pl.bocchi.length) pl.hand.push(pl.bocchi.pop());
        return;
      }
      const n = page === 'PG-017' ? 2 : 1;
      pl.draw(n);
      if (page === 'PG-015') {
        pl.deck = pl.deck.concat(pl.hand); this.rng.shuffle(pl.deck);
        const cnt = pl.hand.length; pl.hand = [];
        for (let i = 0; i < Math.min(cnt, pl.deck.length); i++) pl.hand.push(pl.deck.pop());
      }
    }

    // 1ターン分(両側とも貪欲AI)。
    autoTurn(t) {
      this.turn = t;
      const pi = (this.first + t) % 2;
      this.active = pi;
      this.bj_used = false;
      const page = this.track[t];
      const pl = this.players[pi];
      for (const u of pl.field) { u.sick = false; u.temp = 0; u.no_botsu = false; u.locked = false; }
      for (const u of this.players[1 - pi].field) { u.temp = 0; u.no_botsu = false; u.locked = false; }
      this.pageStart(pi, page);
      this.doDraw(pi, page, t === 0);
      if (pl.work === 'RIBBON') {
        const ready = pl.field.some(u => !u.sick);
        pl.heart = ready ? 'prince' : 'princess';
      }
      if (pl.work === 'ATOM') this.atomDice(pi);
      this.autoMainPhase(pi, page);
      this.autoBattlePhase(pi, page);
      if (pl.hasWon()) return [pi, t + 1, 'win'];
      if (this.players[1 - pi].hasWon()) return [1 - pi, t + 1, 'win'];
      this.pageEnd(pi, page);
      if (pl.hasWon()) return [pi, t + 1, 'win'];
      if (this.players[1 - pi].hasWon()) return [1 - pi, t + 1, 'win'];
      return null;
    }

    // 全自動で1試合(AI vs AI)。{winner, turns, kind} を返す。
    runAuto() {
      for (let t = 0; t < MAX_TURNS; t++) {
        const r = this.autoTurn(t);
        if (r) return { winner: r[0], turns: r[1], kind: r[2] };
      }
      const a = this.players[0].genkoNames().size;
      const b = this.players[1].genkoNames().size;
      if (a > b) return { winner: 0, turns: MAX_TURNS, kind: 'timeout' };
      if (b > a) return { winner: 1, turns: MAX_TURNS, kind: 'timeout' };
      return { winner: null, turns: MAX_TURNS, kind: 'draw' };
    }
  }

  const V7 = {
    makeRng, WIN_GENKO, MAX_TURNS, FIELD_CAP, TRAP_CAP, DEFAULT_CFG,
    baseAtk, WORKS, SPLASH, LEADERS, LEADER_LABEL, PAGE_POOL,
    makeChar, makeKt, buildDeck, newUnit, removeItem, Player, Game,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = V7;
  else root.V7Engine = V7;
})(typeof window !== 'undefined' ? window : globalThis);
