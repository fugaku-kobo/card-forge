# -*- coding: utf-8 -*-
"""手塚カードゲーム v7 — モンテカルロ・シミュレーター(ページカード込み)

docs/rule_v7.md の修正後ルールを再現し、4リーダーの勝率・試合長・引分/時間切れ率を測定する。

▼意図的な簡略化(統計の傾向把握が目的のため)
- キャラ攻撃力は v7 の計算式で生成(xlsx の個別値は未使用)。
- 各リーダーのデッキ=自作品4名×4枚 + 汎用2名×4枚 + 急展開6枚(計30)。勝利に必要な
  「異なる5名」が必ず確保できる構成。
- AI は貪欲ヒューリスティック(最適プレイではない)。両陣営とも同一AIなので相対比較は妥当。
- 情報系ページカード(PG-006/008/009)はヒューリスティックAIに影響しないため no-op。
- キーワード(盾持ち/守り手)は未実装。急展開カードは KT-002/003 のみAIが能動使用。

実行: python sim/v7_sim.py
"""
import random
from collections import Counter

WIN_GENKO = 4          # 勝利=異なる名前のキャラ4枚(2026-05-22 シミュで確定)
MAX_TURNS = 20         # ページカード20枚=20ターンで終了
FIELD_CAP = 3
TRAP_CAP = 2

# ---------------- 攻撃力計算式 ----------------
def base_atk(lv, has_ability, is_star):
    a = 2 if lv == 1 else 4
    if not has_ability:      # 通常変種 +1
        a += 1
    if is_star:              # 主役キャラ +1
        a += 1
    return a

# ---------------- 作品データ ----------------
# name -> (role, ability_tag)   role: 'star' / 'sub'
WORKS = {
    'BJ': {
        'ブラック・ジャック': ('star', 'mesu'),
        'ピノコ':            ('sub',  'pinoko'),
        '本間丈太郎':         ('sub',  'iishi'),
        'ドクター・キリコ':   ('sub',  'anraku'),
    },
    'ATOM': {
        '鉄腕アトム':   ('star', 'horsepower'),
        'ウラン':       ('sub',  'uran'),
        'コバルト':     ('sub',  'cobalt'),
        'お茶の水博士': ('sub',  'ochanomizu'),
    },
    'HINOTORI': {
        '火の鳥':   ('star', 'fushicho'),
        'ナギC':    ('sub',  'nagi_c'),
        '猿田彦':   ('sub',  'sarutahiko'),
        '天弓彦':   ('sub',  'amayumihiko'),
    },
    'RIBBON': {
        'サファイア':   ('star', 'gin'),
        'チンク':       ('sub',  'chink'),
        'フランツ王子': ('sub',  'franz'),
        'ヘケート':     ('sub',  'hecate'),
    },
}
SPLASH = ['ロック', '写楽']     # 汎用スプラッシュ名(能力なし)


def make_char(name, lv, has_ability, is_star, ability):
    return {'kind': 'char', 'name': name, 'lv': lv,
            'has_ability': has_ability, 'is_star': is_star,
            'ability': ability if has_ability else None,
            'base': base_atk(lv, has_ability, is_star)}


def make_kt(ktid):
    return {'kind': 'kt', 'ktid': ktid}


def build_deck(work):
    deck = []
    for name, (role, tag) in WORKS[work].items():
        star = (role == 'star')
        # 4枚: L1能力x2 / L2能力x1 / L2通常x1
        deck.append(make_char(name, 1, True,  star, tag))
        deck.append(make_char(name, 1, True,  star, tag))
        deck.append(make_char(name, 2, True,  star, tag))
        deck.append(make_char(name, 2, False, star, tag))
    for name in SPLASH:
        # 汎用: L1通常x2 / L2通常x2
        deck.append(make_char(name, 1, False, False, None))
        deck.append(make_char(name, 1, False, False, None))
        deck.append(make_char(name, 2, False, False, None))
        deck.append(make_char(name, 2, False, False, None))
    for ktid in ['KT-003', 'KT-003', 'KT-002', 'KT-002', 'KT-005', 'KT-005']:
        deck.append(make_kt(ktid))
    assert len(deck) == 30, len(deck)
    return deck


# ---------------- ページカードプール ----------------
PAGE_POOL = ['PG-%03d' % i for i in range(1, 31)]


class Player:
    def __init__(self, work):
        self.work = work
        self.deck = build_deck(work)
        random.shuffle(self.deck)
        self.hand = []
        self.field = []       # list of units
        self.bocchi = []      # 没案
        self.exile = []       # 完全ボツ
        self.genko = []       # 原稿(得点)
        self.traps = []       # (card, set_turn)
        self.heart = 'prince' # サファイア用
        self.fushicho_used = False
        for _ in range(5):
            self.hand.append(self.deck.pop())
        # 簡易マリガン: キャラが2枚未満なら1回引き直し
        if sum(1 for c in self.hand if c['kind'] == 'char') < 2:
            self.deck += self.hand
            random.shuffle(self.deck)
            self.hand = [self.deck.pop() for _ in range(5)]

    def draw(self, n=1):
        for _ in range(n):
            if self.deck:
                self.hand.append(self.deck.pop())

    def genko_names(self):
        return {c['name'] for c in self.genko}

    def has_won(self):
        return len(self.genko_names()) >= WIN_GENKO


def new_unit(card):
    return {'card': card, 'cards': [card], 'sick': True,
            'perm': 0, 'temp': 0, 'no_botsu': False, 'locked': False,
            'iishi': False}


class Game:
    def __init__(self, workA, workB, log=False):
        self.players = [Player(workA), Player(workB)]
        self.log = log
        track = random.sample(PAGE_POOL, MAX_TURNS)
        self.track = track
        self.turn = 0
        self.first = random.randint(0, 1)   # 先攻

    # ---- 攻撃力(状況込み) ----
    def eff_atk(self, pi, unit, page, active):
        c = unit['card']
        a = 3 if page == 'PG-002' else c['base']
        a += unit['perm'] + unit['temp']
        ab = c['ability']
        pl = self.players[pi]
        if ab == 'horsepower' and len(pl.field) >= 3:
            a += 3
        if ab == 'pinoko' and any(u['card']['name'] == 'ブラック・ジャック' for u in pl.field):
            a += 2
        if ab == 'franz' and pl.heart == 'prince':
            a += 3
        if ab == 'gin' and pl.heart == 'prince':
            a += 2
        if page == 'PG-020' and c['lv'] == 2:
            a += 2
        if page == 'PG-013' and pi == active:
            a -= 2
        if page == 'PG-014' and pi != active:
            a -= 2
        return max(1, a)

    # ---- 没案へ送る(完全ボツ・蘇生トリガー対応) ----
    def to_bocchi(self, pi, unit_or_card, page):
        pl = self.players[pi]
        cards = unit_or_card['cards'] if 'cards' in unit_or_card else [unit_or_card]
        for card in cards:
            if page == 'PG-012':
                pl.exile.append(card)
                continue
            if card.get('ability') == 'fushicho' and not pl.fushicho_used:
                pl.fushicho_used = True
                pl.hand.append(card)            # 簡略: 即手札へ
                continue
            if card.get('ability') == 'nagi_c':
                pl.draw(1)
            pl.bocchi.append(card)

    # ---- ETB能力 ----
    def trigger_etb(self, pi, unit, page):
        ab = unit['card']['ability']
        pl = self.players[pi]
        opp = self.players[1 - pi]
        if ab == 'mesu' and opp.field:
            random.choice(opp.field)['temp'] -= 3
        elif ab == 'iishi':
            bjs = [u for u in pl.field
                   if u['card']['name'] == 'ブラック・ジャック' and not u['iishi']]
            if bjs:
                t = max(bjs, key=lambda u: u['card']['base'])
                t['perm'] += 2
                t['iishi'] = True
        elif ab == 'anraku':
            weak = [u for u in opp.field
                    if self.eff_atk(1 - pi, u, page, self.active) <= 2]
            if weak:
                victim = weak[0]
                opp.field.remove(victim)
                self.to_bocchi(1 - pi, victim, page)
        elif ab == 'uran':
            for u in pl.field:
                if u is not unit:
                    u['temp'] += 1
        elif ab == 'cobalt':
            if len(pl.field) >= 3:
                pl.draw(2)
        elif ab == 'ochanomizu':
            pl.draw(1)
        elif ab == 'sarutahiko':
            if any(c['kind'] == 'char' and c['name'] == '猿田彦' for c in pl.bocchi):
                unit['perm'] += 2
        elif ab == 'amayumihiko':
            l1 = [u for u in opp.field if u['card']['lv'] == 1]
            if l1:
                victim = random.choice(l1)
                opp.field.remove(victim)
                for card in victim['cards']:
                    opp.hand.append(card)
        elif ab == 'chink':
            pl.heart = 'prince'
        elif ab == 'hecate' and opp.field:
            random.choice(opp.field)['temp'] -= 2

    # ---- メインフェイズ ----
    def main_phase(self, pi, page):
        pl = self.players[pi]
        # ナギ「輪廻」
        if pl.work == 'HINOTORI' and len(pl.field) < FIELD_CAP:
            revivable = [c for c in pl.bocchi if c['kind'] == 'char']
            if revivable:
                card = max(revivable, key=lambda c: c['base'])
                pl.bocchi.remove(card)
                u = new_unit(card)
                u['perm'] += 2          # 蘇生キャラ攻撃力+2
                pl.field.append(u)
                self.trigger_etb(pi, u, page)
        # 進化
        for u in list(pl.field):
            if u['card']['lv'] == 1:
                ev = next((c for c in pl.hand if c['kind'] == 'char'
                           and c['name'] == u['card']['name'] and c['lv'] == 2), None)
                if ev:
                    pl.hand.remove(ev)
                    u['cards'].append(ev)
                    u['card'] = ev
        # キャラ召喚(最大3枚・場3枠)
        plays = 0
        while plays < 3 and len(pl.field) < FIELD_CAP:
            chars = [c for c in pl.hand if c['kind'] == 'char']
            if not chars:
                break
            # 評価: 能力持ち優先 + base 高い
            card = max(chars, key=lambda c: c['base'] + (2 if c['ability'] else 0))
            pl.hand.remove(card)
            u = new_unit(card)
            pl.field.append(u)
            self.trigger_etb(pi, u, page)
            plays += 1
            if page == 'PG-018':                 # 描き飛ばし
                for _ in range(2):
                    if pl.deck:
                        self.to_bocchi(pi, pl.deck.pop(), page)
        # 急展開カードを伏せる
        while len(pl.traps) < TRAP_CAP:
            kt = next((c for c in pl.hand if c['kind'] == 'kt'), None)
            if not kt:
                break
            pl.hand.remove(kt)
            pl.traps.append([kt, self.turn])

    # ---- ブロック選択 ----
    def choose_block(self, def_i, atk_eff, blockers_used, page, scoring_new):
        pl = self.players[def_i]
        cands = [u for u in pl.field if not u['locked']]   # 執刀でロックされた壁は不可
        if not cands:
            return None
        if page == 'PG-024' and blockers_used >= 1:
            return None
        rev = (page == 'PG-001')
        best, best_score = None, -99
        for u in cands:
            be = self.eff_atk(def_i, u, page, self.active)
            if pl.work == 'RIBBON' and pl.heart == 'princess':
                be += 2
            if not rev:
                kills = be > atk_eff
                survives = be > atk_eff
                trade = (be == atk_eff)
            else:
                kills = be < atk_eff
                survives = be < atk_eff
                trade = (be == atk_eff)
            sc = (3 if kills and survives else 0) + (2 if trade else 0)
            if not kills and not trade:        # ただのチャンプ
                sc = 1 if scoring_new else -5
            sc -= u['card']['base'] * 0.05      # 大型温存の微バイアス
            if sc > best_score:
                best, best_score = u, sc
        return best if best_score > -5 else None

    # ---- 得点処理 ----
    def score(self, pi, unit, page, unblocked):
        pl = self.players[pi]
        name = unit['card']['name']
        if name in pl.genko_names():
            self.to_bocchi(pi, unit, page)     # 同名重複→没案+2ドロー
            pl.draw(2)
            return
        for card in unit['cards']:
            pl.genko.append(card)
        if unblocked and page == 'PG-030':
            pl.draw(1)
        if page == 'PG-016':                   # おまけページ
            extra = [c for c in pl.bocchi
                     if c['kind'] == 'char' and c['name'] not in pl.genko_names()]
            if extra:
                c = extra[0]
                pl.bocchi.remove(c)
                pl.genko.append(c)

    # ---- バトルフェイズ ----
    def battle_phase(self, pi, page):
        atk_pl = self.players[pi]
        def_i = 1 - pi
        ignore_sick = (page == 'PG-023')
        attackers = [u for u in atk_pl.field
                     if (not u['sick'] or ignore_sick)
                     and u['card']['name'] not in atk_pl.genko_names()]
        attackers.sort(key=lambda u: self.eff_atk(pi, u, page, self.active), reverse=True)
        max_atk = 1 if page == 'PG-025' else 99
        done = 0
        blockers_used = 0
        # BJ「執刀」(1ターン1度): 強敵ブロッカーをロック or 自分のアタッカーを救命+強化
        if atk_pl.work == 'BJ' and not self.bj_used and attackers:
            best = attackers[0]
            bae = self.eff_atk(pi, best, page, self.active)
            blks = sorted(self.players[def_i].field,
                          key=lambda x: self.eff_atk(def_i, x, page, self.active),
                          reverse=True)
            if blks and self.eff_atk(def_i, blks[0], page, self.active) >= bae + 2:
                blks[0]['locked'] = True              # 強敵の壁を無力化して縦に通す
            else:
                best['temp'] += 2                     # 救命+攻撃力+2
                best['no_botsu'] = True
            self.bj_used = True
        for u in list(attackers):
            if done >= max_atk:
                break
            if u not in atk_pl.field:
                continue
            done += 1
            ae = self.eff_atk(pi, u, page, self.active)
            if atk_pl.work == 'RIBBON' and atk_pl.heart == 'prince':
                ae += 2
            # KT-003 で押し込み
            if self._wants_push(pi, u, ae, def_i, page):
                kt = self._pop_trap(atk_pl, 'KT-003')
                if kt:
                    u['temp'] += 3; ae += 3
            scoring_new = True
            blk = self.choose_block(def_i, ae, blockers_used, page, scoring_new)
            if blk is None:
                atk_pl.field.remove(u)
                self.score(pi, u, page, unblocked=True)
            else:
                blockers_used += 1
                be = self.eff_atk(def_i, blk, page, self.active)
                if self.players[def_i].work == 'RIBBON' and self.players[def_i].heart == 'princess':
                    be += 2
                rev = (page == 'PG-001')
                if page in ('PG-003', 'PG-004'):
                    da, db = random.randint(1, 6), random.randint(1, 6)
                    while da == db:
                        da, db = random.randint(1, 6), random.randint(1, 6)
                    atk_win = (da > db) if page == 'PG-003' else (da < db)
                    tie = False
                elif page == 'PG-005':
                    av = bv = 0
                    if atk_pl.deck:
                        t5 = atk_pl.deck.pop()
                        av = t5.get('base', 0)
                        atk_pl.bocchi.append(t5)
                    if self.players[def_i].deck:
                        t5 = self.players[def_i].deck.pop()
                        bv = t5.get('base', 0)
                        self.players[def_i].bocchi.append(t5)
                    atk_win = av > bv
                    tie = (av == bv)
                else:
                    atk_win = (ae < be) if rev else (ae > be)
                    tie = (ae == be)
                if tie:
                    if not u['no_botsu']:               # 没にならない→場に残る
                        atk_pl.field.remove(u)
                        self.to_bocchi(pi, u, page)
                    if not blk['no_botsu']:
                        self.players[def_i].field.remove(blk)
                        self.to_bocchi(def_i, blk, page)
                elif atk_win:
                    if not blk['no_botsu']:
                        self.players[def_i].field.remove(blk)
                        self.to_bocchi(def_i, blk, page)
                    atk_pl.field.remove(u)
                    self.score(pi, u, page, unblocked=False)
                else:
                    if not u['no_botsu']:               # 没にならない→場に残る
                        atk_pl.field.remove(u)
                        self.to_bocchi(pi, u, page)
            if atk_pl.has_won():
                return

    def _pop_trap(self, pl, ktid):
        for i, (kt, st) in enumerate(pl.traps):
            if kt['ktid'] == ktid and st < self.turn:
                pl.traps.pop(i)
                pl.bocchi.append(kt)
                return kt
        return None

    def _wants_push(self, pi, u, ae, def_i, page):
        # 相手に ae 以上のブロッカーがいて、+3 で上回れるなら押す
        opp = self.players[def_i]
        for b in opp.field:
            be = self.eff_atk(def_i, b, page, self.active)
            if ae <= be < ae + 3:
                return True
        return False

    # ---- リーダー: アトムのダイス ----
    def atom_dice(self, pi):
        pl = self.players[pi]
        for _ in range(3):                      # 出目6(振り直し)を最大2回
            r = random.randint(1, 6)
            if r == 1 and pl.field:
                max(pl.field, key=lambda u: u['card']['base'])['temp'] += 4
            elif r == 2:
                for u in pl.field:
                    u['sick'] = False
            elif r == 3:
                pl.draw(2)
            elif r == 4 and self.players[1 - pi].field:
                random.choice(self.players[1 - pi].field)['temp'] -= 3
            elif r == 5:
                chars = [c for c in pl.bocchi if c['kind'] == 'char']
                if chars:
                    c = max(chars, key=lambda c: c['base'])
                    pl.bocchi.remove(c)
                    pl.hand.append(c)
            if r != 6:
                break

    # ---- ページカード(ターン開始時) ----
    def page_start(self, pi, page):
        pl, opp = self.players[pi], self.players[1 - pi]
        if page == 'PG-022' and pl.field:
            top = max(pl.field, key=lambda u: self.eff_atk(pi, u, page, self.active))
            top['temp'] += 3
        elif page == 'PG-007':
            for p in (pl, opp):
                if p.bocchi:
                    p.hand.append(p.bocchi.pop())
        elif page == 'PG-027':
            for p in (pl, opp):
                chars = [c for c in p.bocchi if c['kind'] == 'char']
                if chars:
                    p.bocchi.remove(chars[0]); p.hand.append(chars[0])
        elif page == 'PG-028':
            pl.draw(2); opp.draw(2)

    # ---- ページカード(ターン終了時) ----
    def page_end(self, pi, page):
        pl, opp = self.players[pi], self.players[1 - pi]
        if page == 'PG-019':                    # 一気描き
            pl.bocchi += [c for c in pl.hand]
            pl.hand = []
            pl.draw(5)
        elif page == 'PG-026':                  # 読者人気投票
            a, b = len(pl.genko_names()), len(opp.genko_names())
            if a < b:
                pl.draw(2)
            elif b < a:
                opp.draw(2)
            else:
                pl.draw(1); opp.draw(1)
        elif page == 'PG-029':                  # 打ち切り会議
            for p, idx in ((pl, pi), (opp, 1 - pi)):
                if p.field:
                    victim = min(p.field, key=lambda u: u['card']['base'])
                    p.field.remove(victim)
                    self.to_bocchi(idx, victim, page)

    # ---- ドロー処理(ページ効果込み) ----
    def do_draw(self, pi, page, skip):
        pl = self.players[pi]
        if skip:
            return
        if page == 'PG-010':                    # スランプ
            if pl.hand:
                pl.bocchi.append(pl.hand.pop(random.randrange(len(pl.hand))))
            elif pl.bocchi:
                pl.hand.append(pl.bocchi.pop())
            return
        n = 2 if page == 'PG-017' else 1        # 筆が乗る
        pl.draw(n)
        if page == 'PG-015':                    # 仕切り直し
            pl.deck += pl.hand
            random.shuffle(pl.deck)
            cnt = len(pl.hand)
            pl.hand = [pl.deck.pop() for _ in range(min(cnt, len(pl.deck)))]

    # ---- 1ゲーム実行 ----
    def run(self):
        for t in range(MAX_TURNS):
            self.turn = t
            pi = (self.first + t) % 2
            self.active = pi
            self.bj_used = False
            page = self.track[t]
            pl = self.players[pi]
            for u in pl.field:                  # 召喚酔い解除・一時効果リセット
                u['sick'] = False
                u['temp'] = 0
                u['no_botsu'] = False
                u['locked'] = False
            for u in self.players[1 - pi].field:
                u['temp'] = 0
                u['no_botsu'] = False
                u['locked'] = False
            # ①ページ送り
            self.page_start(pi, page)
            # ②ドロー
            skip = (t == 0)                     # 先攻1ターン目スキップ
            self.do_draw(pi, page, skip)
            # サファイア/アトム リーダー
            if pl.work == 'RIBBON':
                ready = sum(1 for u in pl.field if not u['sick'])
                pl.heart = 'prince' if ready else 'princess'
            if pl.work == 'ATOM':
                self.atom_dice(pi)
            # ③メイン
            self.main_phase(pi, page)
            # ④バトル
            self.battle_phase(pi, page)
            if pl.has_won():
                return (pi, t + 1, 'win')
            if self.players[1 - pi].has_won():
                return (1 - pi, t + 1, 'win')
            # ⑤エンド
            self.page_end(pi, page)
            if pl.has_won():
                return (pi, t + 1, 'win')
            if self.players[1 - pi].has_won():
                return (1 - pi, t + 1, 'win')
        # 時間切れ: 原稿数で判定
        a = len(self.players[0].genko_names())
        b = len(self.players[1].genko_names())
        if a > b:
            return (0, MAX_TURNS, 'timeout')
        if b > a:
            return (1, MAX_TURNS, 'timeout')
        return (None, MAX_TURNS, 'draw')


def run_config(trials, seed, win_genko, max_turns):
    """指定の[勝利名数 / ページ枚数]で trials 試合し、統計を返す。"""
    global WIN_GENKO, MAX_TURNS
    WIN_GENKO = win_genko
    MAX_TURNS = max_turns
    random.seed(seed)
    leaders = ['BJ', 'ATOM', 'HINOTORI', 'RIBBON']
    wins = Counter()
    games = Counter()
    win_turn_sum = 0
    win_n = 0
    draws = 0
    timeouts = 0
    for _ in range(trials):
        a, b = random.sample(leaders, 2)
        g = Game(a, b)
        winner, nturns, kind = g.run()
        games[a] += 1
        games[b] += 1
        if kind == 'draw':
            draws += 1
        else:
            wins[[a, b][winner]] += 1
            if kind == 'timeout':
                timeouts += 1
            else:                       # 5フェイズ内での通常勝利
                win_turn_sum += nturns
                win_n += 1
    wr = {L: 100.0 * wins[L] / games[L] for L in leaders}
    return {
        'wg': win_genko, 'mt': max_turns,
        'decisive': (win_turn_sum / win_n) if win_n else 0.0,
        'normal_win': 100.0 * win_n / trials,
        'draw': 100.0 * draws / trials,
        'timeout': 100.0 * timeouts / trials,
        'wr': wr,
        'spread': max(wr.values()) - min(wr.values()),
    }


def sweep():
    """勝利名数 × ページ枚数 のスイープ。試合長の最適点を探す。"""
    configs = [(5, 20), (5, 16), (4, 20), (4, 16), (4, 14), (4, 12)]
    lines = []
    lines.append('=== v7 試合長スイープ(各12000試合・ページカード込み)===')
    lines.append('勝利 ページ | 通常勝利% 平均決着T 引分% 時間切れ% | 勝率差 '
                 'BJ/ATOM/HINO/RIBBON')
    for wg, mt in configs:
        r = run_config(12000, 42, wg, mt)
        lines.append(
            '  %d名  %2d枚 | %7.1f %8.1f %6.1f %8.1f | %5.1f  %.0f/%.0f/%.0f/%.0f'
            % (r['wg'], r['mt'], r['normal_win'], r['decisive'], r['draw'],
               r['timeout'], r['spread'], r['wr']['BJ'], r['wr']['ATOM'],
               r['wr']['HINOTORI'], r['wr']['RIBBON']))
    report = '\n'.join(lines)
    try:
        print(report)
    except UnicodeEncodeError:
        print(report.encode('utf-8', 'replace').decode('ascii', 'replace'))
    with open('sim/v7_sweep.txt', 'w', encoding='utf-8') as f:
        f.write(report + '\n')
    print('--> sim/v7_sweep.txt に保存しました')


if __name__ == '__main__':
    sweep()
