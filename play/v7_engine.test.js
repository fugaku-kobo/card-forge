/* v7_engine.js のバランス回帰テスト(Node)
 * Python の sim/v7_sim.py と統計一致するかを確認する。
 * 期待値(各12000試合): BJ≈45 ATOM≈46 HINO≈52 RIBBON≈54 / 勝率差≈9 / 通常勝利≈97% / 決着≈10.6T
 * 実行: node play/v7_engine.test.js
 */
const V7 = require('./v7_engine.js');

function runConfig(trials, seed) {
  const rng = V7.makeRng(seed);
  const leaders = V7.LEADERS.slice();
  const wins = {}, games = {};
  leaders.forEach(L => { wins[L] = 0; games[L] = 0; });
  let winTurnSum = 0, winN = 0, draws = 0, timeouts = 0;
  for (let i = 0; i < trials; i++) {
    const pair = rng.sample(leaders, 2);
    const g = new V7.Game(pair[0], pair[1], rng);
    const res = g.runAuto();
    games[pair[0]]++; games[pair[1]]++;
    if (res.kind === 'draw') { draws++; continue; }
    wins[pair[res.winner]]++;
    if (res.kind === 'timeout') timeouts++;
    else { winTurnSum += res.turns; winN++; }
  }
  const wr = {}; leaders.forEach(L => { wr[L] = 100 * wins[L] / games[L]; });
  const vals = Object.values(wr);
  return {
    wr, spread: Math.max(...vals) - Math.min(...vals),
    decisive: winN ? winTurnSum / winN : 0,
    normalWin: 100 * winN / trials, draw: 100 * draws / trials, timeout: 100 * timeouts / trials,
  };
}

function matchup(trials, seedBase) {
  const leaders = V7.LEADERS.slice();
  const lines = [`--- 対戦相性(各${trials}試合・引分除く・左の勝率%)---`];
  for (let i = 0; i < leaders.length; i++) for (let j = i + 1; j < leaders.length; j++) {
    const a = leaders[i], b = leaders[j];
    const rng = V7.makeRng(seedBase);
    let aw = 0, bw = 0;
    for (let k = 0; k < trials; k++) {
      const res = new V7.Game(a, b, rng).runAuto();
      if (res.kind === 'draw') continue;
      if (res.winner === 0) aw++; else bw++;
    }
    const tot = Math.max(1, aw + bw);
    lines.push(`  ${a.padEnd(9)} ${(100 * aw / tot).toFixed(1)}  vs  ${(100 * bw / tot).toFixed(1)}  ${b}`);
  }
  return lines;
}

const N = 12000;
const r = runConfig(N, 42);
console.log('=== v7_engine.js バランス回帰(各%d試合)===', N);
console.log('JS engine | BJ %s ATOM %s HINO %s RIBBON %s | 勝率差 %s | 通常勝利 %s%% 引分 %s%% 決着 %sT',
  r.wr.BJ.toFixed(0), r.wr.ATOM.toFixed(0), r.wr.HINOTORI.toFixed(0), r.wr.RIBBON.toFixed(0),
  r.spread.toFixed(1), r.normalWin.toFixed(0), r.draw.toFixed(1), r.decisive.toFixed(1));
console.log('期待(Python) | BJ 45 ATOM 46 HINO 52 RIBBON 54 | 勝率差 9.0 | 通常勝利 97% 引分 1.7% 決着 10.6T');
console.log('');
console.log(matchup(2500, 777).join('\n'));

// 簡易アサーション(統計的に±5pt以内なら合格)
const exp = { BJ: 45, ATOM: 46, HINOTORI: 52, RIBBON: 54 };
let ok = true;
for (const L of V7.LEADERS) {
  const d = Math.abs(r.wr[L] - exp[L]);
  if (d > 5) { ok = false; console.log(`  ✗ ${L} 乖離 ${d.toFixed(1)}pt`); }
}
if (r.normalWin < 90) { ok = false; console.log('  ✗ 通常勝利率が低い'); }
console.log(ok ? '\n✅ 回帰合格: Python sim と統計一致' : '\n❌ 回帰不一致: 移植ロジック要確認');
process.exit(ok ? 0 : 1);
