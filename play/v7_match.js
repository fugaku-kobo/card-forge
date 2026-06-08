/* 手塚カードゲーム v7 — 対戦コントローラ(人間 vs AI)
 *
 * v7_engine.js のプリミティブを使い、ターンを段階的に進める状態機械。
 *  - 人間の手番: 召喚/進化/急展開セット → 攻撃宣言(AIが貪欲ブロック)。
 *  - AIの手番  : 貪欲 or MCTS で行動。攻撃のたびに人間がブロックを選ぶ。
 *  - リーダー能力(ATOMダイス/ナギ輪廻/RIBBON心/BJ執刀)・ページ/ドローは自動。
 *
 * MCTS: AIの手番開始時に「最大の1体を壁として温存するか」をロールアウトで決める軽量版。
 *
 * UIは view() のスナップショットを描画し、pending に応じて人間の入力メソッドを呼ぶ。
 */
(function (root) {
  'use strict';
  const V7 = (typeof require !== 'undefined') ? require('./v7_engine.js') : root.V7Engine;

  // ページカード表示用(簡潔版)
  const PAGE_INFO = {
    'PG-001': ['逆転劇', '戦闘は攻撃力の低い方が勝つ'],
    'PG-002': ['画風変更', '全キャラの攻撃力を300に。以後のバフ/デバフのみ加減'],
    'PG-003': ['大勝負', '戦闘はダイスの大きい方が勝つ'],
    'PG-004': ['番狂わせ', '戦闘はダイスの小さい方が勝つ'],
    'PG-005': ['出たとこ勝負', '戦闘はデッキトップの攻撃力で決める'],
    'PG-006': ['ネタばらし', 'お互い手札公開(影響なし)'],
    'PG-007': ['没案あさり', '各自 没案1枚を手札へ'],
    'PG-008': ['先読み', 'デッキトップ閲覧(影響なし)'],
    'PG-009': ['ネーム整理', 'デッキトップ3枚を並べ替え(影響なし)'],
    'PG-010': ['スランプ', 'ドローの代わりに手札1枚を捨てる'],
    'PG-011': ['反撃開始', '盾持ちも攻撃できる'],
    'PG-012': ['完全ボツ', '没になったカードは除外'],
    'PG-013': ['自陣の乱れ', '自分の場のキャラは攻撃力-200(最低100)'],
    'PG-014': ['敵陣の乱れ', '相手の場のキャラは攻撃力-200(最低100)'],
    'PG-015': ['仕切り直し', '手札を山に戻し同枚数引き直し'],
    'PG-016': ['おまけページ', '得点時 没案からもう1枚原稿へ'],
    'PG-017': ['筆が乗る', 'ドローが倍'],
    'PG-018': ['描き飛ばし', 'キャラを出すたびデッキトップ2枚を没案へ'],
    'PG-019': ['一気描き', 'ターン終了時 手札を捨て5ドロー'],
    'PG-020': ['ベテランの風格', 'Lv2のキャラは攻撃力+200'],
    'PG-021': ['平常運転', '何も起きない'],
    'PG-022': ['クライマックス', '最も高いキャラ1体は攻撃力+300'],
    'PG-023': ['総力戦', '召喚酔いでも攻撃できる'],
    'PG-024': ['見開きの大ゴマ', '防御側はブロック1回まで'],
    'PG-025': ['休載明け', '攻撃は1回まで'],
    'PG-026': ['読者人気投票', 'ターン終了時 原稿が少ない方が2ドロー'],
    'PG-027': ['新キャラ投入', '各自 没案のキャラ1体を手札へ'],
    'PG-028': ['ネタ出し会議', '各自2ドロー'],
    'PG-029': ['打ち切り会議', 'ターン終了時 各自 場のキャラ1体を没案へ'],
    'PG-030': ['伝説の一話', '無ブロック得点で追加1ドロー'],
  };
  const ABILITY_LABEL = {
    mesu: 'メス', pinoko: 'ピノコもいるのよ', iishi: '医の遺志', anraku: '安楽死',
    horsepower: '十万馬力', uran: '妹のはげまし', cobalt: '数の力', ochanomizu: '博士の助言',
    fushicho: '不死鳥', nagi_c: '不屈の少年', sarutahiko: '転生', amayumihiko: '弓',
    gin: '銀の騎士', chink: '天使のいたずら', franz: '白馬の王子', hecate: '魔女の娘',
  };
  const KT_LABEL = { 'KT-002': '没ネーム', 'KT-003': 'アシスタント呼出', 'KT-005': '読者の声' };

  function cloneGame(game, rng) {
    const c = Object.create(V7.Game.prototype);
    c.rng = rng; c.cfg = game.cfg;
    c.works = game.works.slice(); c.track = game.track.slice();
    c.turn = game.turn; c.first = game.first; c.active = game.active; c.bj_used = game.bj_used;
    c.log = [];
    // rng(関数)は structuredClone できないので、データ列だけのスナップショットを複製する。
    c.players = game.players.map(pl => {
      const snap = structuredClone({
        work: pl.work, deck: pl.deck, hand: pl.hand, field: pl.field,
        bocchi: pl.bocchi, exile: pl.exile, genko: pl.genko, traps: pl.traps,
        heart: pl.heart, fushicho_used: pl.fushicho_used,
      });
      Object.setPrototypeOf(snap, V7.Player.prototype);
      snap.rng = rng;
      return snap;
    });
    return c;
  }

  class V7Match {
    constructor(opts) {
      opts = opts || {};
      this.humanWork = opts.humanWork || 'BJ';
      this.aiWork = opts.aiWork || 'ATOM';
      this.aiMode = opts.aiMode || 'greedy';       // 'greedy' | 'mcts'
      this.aiDelay = opts.aiDelayMs || 0;          // AIターンでページめくりを見せる遅延(ms・UI用)
      this.seed = (opts.seed != null) ? opts.seed : Math.floor((Math.random ? Math.random() : 0.5) * 2 ** 31);
      this.rng = V7.makeRng(this.seed);
      this.HUMAN = 0; this.AI = 1;
      // opts.humanDeck/aiDeck: 事前構築のエンジンカード配列(自作デッキ)。なければリーダー内蔵デッキ。
      const optA = opts.humanDeck ? { deck: opts.humanDeck } : { pierce: !!opts.humanPierce };
      const optB = opts.aiDeck ? { deck: opts.aiDeck } : { pierce: !!opts.aiPierce };
      this.game = new V7.Game(this.humanWork, this.aiWork, this.rng, null, optA, optB);
      this.game.first = opts.humanFirst ? this.HUMAN : this.AI;
      this._rolloutSeed = (this.seed ^ 0x5bd1e995) >>> 0;
      this.over = false; this.winner = null; this.winKind = null;
      this.pending = null;       // {type:'main'|'attack'|'block', ...}
      this.log = [];
      this.onUpdate = opts.onUpdate || null;
      this.onLog = opts.onLog || null;
      // バトル内部状態
      this._page = null; this._battle = null;
      this._started = false;
    }

    _emitLog(msg) { this.log.push(msg); if (this.onLog) this.onLog(msg); }
    _update() { if (this.onUpdate) this.onUpdate(); }
    sideName(i) { return i === this.HUMAN ? 'あなた' : 'AI'; }

    start() {
      if (this._started) return;
      this._started = true;
      this._beginTurn(0);
      this._update();
    }

    // ---------------- ターン開始(自動前処理)----------------
    _beginTurn(t) {
      const g = this.game;
      g.turn = t; this._t = t;
      const pi = (g.first + t) % 2;
      g.active = pi; this._active = pi; g.bj_used = false;
      const page = g.track[t]; this._page = page;
      const pl = g.players[pi];
      for (const u of pl.field) { u.sick = false; u.temp = 0; u.no_botsu = false; u.locked = false; }
      for (const u of g.players[1 - pi].field) { u.temp = 0; u.no_botsu = false; u.locked = false; }
      const pinfo = PAGE_INFO[page] || [page, ''];
      this._emitLog(`― ターン${t + 1} [${this.sideName(pi)}] ページ:${pinfo[0]}`);
      g.pageStart(pi, page);
      g.doDraw(pi, page, t === 0);
      if (pl.work === 'RIBBON') { pl.heart = pl.field.some(u => !u.sick) ? 'prince' : 'princess'; }
      if (pl.work === 'ATOM') { const d = g.atomDice(pi); if (d) this._emitLog(`${this.sideName(pi)}: アトムのダイス ${d}`); }
      // KT-005 / ナギ輪廻 は自動
      while (pl.hand.length < 4 && g.popTrap(pl, 'KT-005')) { pl.draw(2); this._emitLog(`${this.sideName(pi)}: 読者の声で2ドロー`); }
      if (pl.work === 'HINOTORI' && pl.field.length < V7.FIELD_CAP) {
        const rev = pl.bocchi.filter(c => c.kind === 'char');
        if (rev.length) {
          const card = rev.reduce((m, c) => c.base > m.base ? c : m, rev[0]);
          V7.removeItem(pl.bocchi, card);
          const u = V7.newUnit(card); u.perm += g.cfg.nagi_revive;
          pl.field.push(u); g.triggerEtb(pi, u, page);
          this._emitLog(`${this.sideName(pi)}: 輪廻で${card.name}を蘇生(+200)`);
        }
      }
      // メインフェイズへ
      if (pi === this.HUMAN) {
        this.pending = { type: 'main' };
      } else if (this.aiDelay > 0 && typeof setTimeout !== 'undefined') {
        // ページめくりを見せてから AI が着手
        this._update();
        setTimeout(() => { if (!this.over && this.game.players) this._aiMainAndBattle(page); }, this.aiDelay);
      } else {
        this._aiMainAndBattle(page);
      }
    }

    // ---------------- AI: メイン+バトル ----------------
    _aiMainAndBattle(page) {
      const g = this.game, pi = this.AI;
      g.autoMainPhase(pi, page);
      // MCTS: 温存判断
      let holdBack = false;
      if (this.aiMode === 'mcts') holdBack = this._mctsHoldBack(page);
      const attackers = g.battlePreSteps(pi, page);
      if (g._bjLog) this._emitLog(`AI: ${g._bjLog}`);
      let queue = attackers.slice();
      if (holdBack && queue.length > 1) queue = queue.slice(1);
      this._battle = { atk: pi, def: this.HUMAN, queue, maxAtk: page === 'PG-025' ? 1 : 99, done: 0, blockersUsed: 0 };
      this._pumpAiBattle();
    }

    _pumpAiBattle() {
      const g = this.game, b = this._battle, page = this._page;
      while (b.queue.length) {
        if (b.done >= b.maxAtk) { b.queue = []; break; }
        const u = b.queue.shift();
        if (g.players[b.atk].field.indexOf(u) < 0) continue;
        b.done++;
        const ae = g.computeAttackEff(b.atk, u, page);
        const opts = this._humanBlockOptions(u);
        if (opts.length === 0) {
          g.settleAttack(b.atk, b.def, u, ae, null, page);
          this._emitLog(`AIの${u.card.name}(${ae})が無ブロックで得点`);
          if (this._checkWinDuringBattle(b.atk)) return;
          continue;
        }
        // 人間にブロックを問う
        this._battle.cur = { u, ae };
        this.pending = { type: 'block', attacker: this._unitView(u, b.atk), ae, options: opts, canPass: true };
        this._update();
        return;
      }
      this._endBattle(b.atk);
    }

    _humanBlockOptions(attacker) {
      const g = this.game, page = this._page, b = this._battle;
      if (page === 'PG-024' && b.blockersUsed >= 1) return [];
      return g.players[this.HUMAN].field.filter(u => !u.locked).map(u => {
        const shieldStop = u.card.shield && !u.shield_used && !attacker.card.pierce;
        let be = g.effAtk(this.HUMAN, u, page, g.active);
        if (g.players[this.HUMAN].heart === 'princess' && g.players[this.HUMAN].work === 'RIBBON') be += 200;
        return { uid: u.uid, name: u.card.name, be, shieldStop };
      });
    }

    // 人間がブロッカーを選択(null=ブロックしない)
    chooseBlock(uidOrNull) {
      if (!this.pending || this.pending.type !== 'block') return;
      const g = this.game, b = this._battle, page = this._page;
      const u = b.cur.u, ae = b.cur.ae;
      let blk = null;
      if (uidOrNull != null) blk = g.players[this.HUMAN].field.find(x => x.uid === uidOrNull) || null;
      this.pending = null;
      if (blk) {
        b.blockersUsed++;
        g.settleAttack(b.atk, b.def, u, ae, blk, page);
        this._emitLog(`あなたの${blk.card.name}がAIの${u.card.name}(${ae})をブロック`);
      } else {
        g.settleAttack(b.atk, b.def, u, ae, null, page);
        this._emitLog(`AIの${u.card.name}(${ae})が得点(ブロックなし)`);
      }
      b.cur = null;
      if (this._checkWinDuringBattle(b.atk)) return;
      this._pumpAiBattle();
    }

    // ---------------- 人間: メインフェイズ ----------------
    playFromHand(handIdx) {
      if (!this.pending || this.pending.type !== 'main') return false;
      const g = this.game, pl = g.players[this.HUMAN], page = this._page;
      const card = pl.hand[handIdx];
      if (!card || card.kind !== 'char') return false;
      // 進化: Lv2 で 同名Lv1 が場にいれば重ねる(召喚枠を消費しない)
      if (card.lv === 2) {
        const tgt = pl.field.find(u => u.card.lv === 1 && u.card.name === card.name);
        if (tgt) {
          V7.removeItem(pl.hand, card); tgt.cards.push(card); tgt.card = card;
          this._emitLog(`あなた: ${card.name}を進化(Lv2)`);
          this._update(); return true;
        }
      }
      // 召喚(場3枠・1ターン3体まで)
      this._plays = this._plays || 0;
      if (pl.field.length >= V7.FIELD_CAP) return false;
      if (this._plays >= 3) return false;
      V7.removeItem(pl.hand, card);
      const u = V7.newUnit(card); pl.field.push(u); g.triggerEtb(this.HUMAN, u, page);
      this._plays++;
      if (page === 'PG-018') for (let k = 0; k < 2; k++) if (pl.deck.length) g.toBocchi(this.HUMAN, pl.deck.pop(), page);
      this._emitLog(`あなた: ${card.name}(Lv${card.lv})を召喚`);
      this._update(); return true;
    }

    setTrapFromHand(handIdx) {
      if (!this.pending || this.pending.type !== 'main') return false;
      const pl = this.game.players[this.HUMAN];
      const card = pl.hand[handIdx];
      if (!card || card.kind !== 'kt') return false;
      if (pl.traps.length >= V7.TRAP_CAP) return false;
      V7.removeItem(pl.hand, card); pl.traps.push([card, this._t]);
      this._emitLog(`あなた: 急展開を伏せた`);
      this._update(); return true;
    }

    // サファイア: 自分のターン開始時(=メイン中)に心を選ぶ
    setHumanHeart(h) {
      if (!this.pending || this.pending.type !== 'main') return false;
      const pl = this.game.players[this.HUMAN];
      if (pl.work !== 'RIBBON') return false;
      pl.heart = (h === 'princess') ? 'princess' : 'prince';
      this._emitLog(`あなた: 心を【${pl.heart === 'prince' ? '王子' : 'お姫さま'}】に`);
      this._update(); return true;
    }

    finishMain() {
      if (!this.pending || this.pending.type !== 'main') return;
      this._plays = 0;
      const g = this.game, page = this._page;
      const attackers = g.battlePreSteps(this.HUMAN, page);
      if (g._bjLog) this._emitLog(`あなた: ${g._bjLog}`);
      this._battle = { atk: this.HUMAN, def: this.AI, pool: attackers, maxAtk: page === 'PG-025' ? 1 : 99, done: 0, blockersUsed: 0, attacked: new Set() };
      this.pending = { type: 'attack' };
      this._update();
    }

    // ---------------- 人間: 攻撃宣言(AIが貪欲ブロック)----------------
    attackableUids() {
      if (!this.pending || this.pending.type !== 'attack') return [];
      const g = this.game, b = this._battle;
      if (b.done >= b.maxAtk) return [];
      return b.pool.filter(u => g.players[this.HUMAN].field.indexOf(u) >= 0 && !b.attacked.has(u.uid)).map(u => u.uid);
    }

    declareAttack(uid) {
      if (!this.pending || this.pending.type !== 'attack') return false;
      const g = this.game, b = this._battle, page = this._page;
      const u = g.players[this.HUMAN].field.find(x => x.uid === uid);
      if (!u || b.pool.indexOf(u) < 0 || b.attacked.has(uid)) return false;
      if (b.done >= b.maxAtk) return false;
      b.done++; b.attacked.add(uid);
      const ae = g.computeAttackEff(this.HUMAN, u, page);
      const blk = g.chooseBlock(this.AI, ae, b.blockersUsed, page, true, u);
      if (blk !== null) { b.blockersUsed++; }
      g.settleAttack(this.HUMAN, this.AI, u, ae, blk, page);
      this._emitLog(blk ? `あなたの${u.card.name}(${ae})をAIの${blk.card.name}がブロック`
        : `あなたの${u.card.name}(${ae})が得点`);
      if (this._checkWinDuringBattle(this.HUMAN)) return true;
      if (b.done >= b.maxAtk) { this.finishAttacks(); return true; }
      this._update();
      return true;
    }

    finishAttacks() {
      if (!this.pending || this.pending.type !== 'attack') return;
      this.pending = null;
      this._endBattle(this.HUMAN);
    }

    // ---------------- バトル終了→ターン終了 ----------------
    _checkWinDuringBattle(active) {
      const g = this.game;
      if (g.players[active].hasWon()) { this._finish(active, 'win'); return true; }
      if (g.players[1 - active].hasWon()) { this._finish(1 - active, 'win'); return true; }
      return false;
    }

    _endBattle(active) {
      const g = this.game, page = this._page;
      if (g.players[active].hasWon()) return this._finish(active, 'win');
      if (g.players[1 - active].hasWon()) return this._finish(1 - active, 'win');
      g.pageEnd(active, page);
      if (g.players[active].hasWon()) return this._finish(active, 'win');
      if (g.players[1 - active].hasWon()) return this._finish(1 - active, 'win');
      // 次ターン
      const nt = this._t + 1;
      if (nt >= V7.MAX_TURNS) {
        const a = g.players[0].genkoNames().size, b = g.players[1].genkoNames().size;
        if (a > b) return this._finish(0, 'timeout');
        if (b > a) return this._finish(1, 'timeout');
        return this._finish(null, 'draw');
      }
      this._beginTurn(nt);
      this._update();
    }

    _finish(winner, kind) {
      this.over = true; this.winner = winner; this.winKind = kind; this.pending = null;
      const who = winner == null ? '引き分け' : (winner === this.HUMAN ? 'あなたの勝ち' : 'AIの勝ち');
      this._emitLog(`▼ ゲーム終了: ${who}(${kind})`);
      this._update();
    }

    // ---------------- MCTS(温存ロールアウト)----------------
    _mctsHoldBack(page) {
      const K = 16;
      const score = (holdBack) => {
        let aiWins = 0;
        for (let k = 0; k < K; k++) {
          this._rolloutSeed = (this._rolloutSeed * 1664525 + 1013904223) >>> 0;
          const g = cloneGame(this.game, V7.makeRng(this._rolloutSeed));
          g.autoBattlePhase(this.AI, page, { holdBack });
          let res = this._tailToEnd(g, this.AI, page);
          if (res === this.AI) aiWins++;
        }
        return aiWins;
      };
      const noHold = score(false), hold = score(true);
      return hold > noHold;
    }

    // クローンで現ターン残り+以降を貪欲消化し、勝者(index|null)を返す
    _tailToEnd(g, active, page) {
      if (g.players[active].hasWon()) return active;
      if (g.players[1 - active].hasWon()) return 1 - active;
      g.pageEnd(active, page);
      if (g.players[active].hasWon()) return active;
      if (g.players[1 - active].hasWon()) return 1 - active;
      for (let t = g.turn + 1; t < V7.MAX_TURNS; t++) {
        const r = g.autoTurn(t);
        if (r) return r[0];
      }
      const a = g.players[0].genkoNames().size, b = g.players[1].genkoNames().size;
      return a > b ? 0 : (b > a ? 1 : null);
    }

    // ---------------- 表示用スナップショット ----------------
    _unitView(u, side) {
      const g = this.game;
      const eff = g.effAtk(side, u, this._page, g.active);
      const c = u.card;
      return {
        uid: u.uid, name: c.name, lv: c.lv, base: c.base, eff,
        ability: c.ability ? (ABILITY_LABEL[c.ability] || c.ability) : null,
        star: c.is_star, sick: u.sick, locked: u.locked, noBotsu: u.no_botsu,
        shield: c.shield, shieldUsed: u.shield_used, pierce: c.pierce,
      };
    }
    _handView(c, idx) {
      if (c.kind === 'char') return { idx, kind: 'char', name: c.name, lv: c.lv, base: c.base, star: c.is_star, ability: c.ability ? (ABILITY_LABEL[c.ability] || c.ability) : null, pierce: c.pierce, shield: c.shield };
      return { idx, kind: 'kt', ktid: c.ktid, name: KT_LABEL[c.ktid] || c.ktid };
    }
    _sideView(i) {
      const g = this.game, pl = g.players[i];
      const genkoNames = Array.from(pl.genkoNames());
      return {
        side: i === this.HUMAN ? 'human' : 'ai',
        work: pl.work, workLabel: V7.LEADER_LABEL[pl.work] || (pl.work === 'NONE' ? '自作' : pl.work), heart: pl.heart,
        field: pl.field.map(u => this._unitView(u, i)),
        hand: i === this.HUMAN ? pl.hand.map((c, idx) => this._handView(c, idx)) : null,
        // 決着後のAI手札公開用(対戦中はUIで非表示)
        handReveal: this.over ? pl.hand.map((c, idx) => this._handView(c, idx)) : null,
        handCount: pl.hand.length, deckCount: pl.deck.length,
        bocchiCount: pl.bocchi.length, exileCount: pl.exile.length,
        trapCount: pl.traps.length,
        genkoNames, genkoCount: genkoNames.length,
      };
    }
    view() {
      const g = this.game, page = this._page;
      const pinfo = PAGE_INFO[page] || ['', ''];
      return {
        turn: (this._t || 0) + 1, maxTurns: V7.MAX_TURNS, winGenko: V7.WIN_GENKO,
        page, pageName: pinfo[0], pageDesc: pinfo[1],
        trackIdx: (this._t || 0),
        track: g.track.map(id => ({ id: id, name: (PAGE_INFO[id] || [id])[0], desc: (PAGE_INFO[id] || ['', ''])[1] })),
        activeSide: this._active === this.HUMAN ? 'human' : 'ai',
        firstSide: g.first === this.HUMAN ? 'human' : 'ai',
        over: this.over, winner: this.winner == null ? null : (this.winner === this.HUMAN ? 'human' : 'ai'), winKind: this.winKind,
        pending: this.pending,
        aiMode: this.aiMode,
        human: this._sideView(this.HUMAN), ai: this._sideView(this.AI),
        logTail: this.log.slice(-40),
      };
    }
  }

  const API = { V7Match, PAGE_INFO, ABILITY_LABEL, KT_LABEL, cloneGame };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.V7Match = API;
})(typeof window !== 'undefined' ? window : globalThis);
