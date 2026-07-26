/*
 * 从 data/ 里的 JSON 生成 index.html。
 *
 * 地图、图例、排行、厂商、节点列表、整张数据表都在这里烘成静态 HTML，
 * 三个视图之间的切换和角色筛选靠单选框 + CSS 完成，所以页面在没有
 * JavaScript 的环境里（手机文件预览、阅读模式、内网离线机器）依然能读全。
 * 运行时的脚本只负责一件事：把光标指到的地方写进右上角的读数框。
 *
 * 用法：node build.js
 */
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const read = name => JSON.parse(fs.readFileSync(path.join(DIR, "data", name), "utf8"));

const WORLD = read("world.json");     // 国名 -> SVG path，Miller 投影下已烘好的坐标
const DATA = read("countries.json");  // 国名 -> {zh, m, pc, role, note}
const NODES = read("nodes.json");     // 城市节点
const FIRMS = read("firms.json");     // 厂商收入构成
const COST = read("cost-model.json"); // 零售价拆解模型：价格水平、税、关税、渠道加价

/* ---------- 配色与分级：全站唯一一份，CSS 和 JS 都从这里派生 ---------- */
const RAMP_M = ["#3A424C", "#255A72", "#1E7C99", "#2FA6BC", "#6FD8CF"];
const RAMP_PC = ["#413F3A", "#6E5330", "#A6762C", "#D9A230", "#F3D45F"];
const RAMP_N = ["#3A404C", "#3F4E7E", "#5361A8", "#7A7ECB", "#AEA9EE"];
const RAMP_G = ["#39443E", "#2C6350", "#2A8763", "#46B078", "#84DFA4"];
const M_BREAKS = [0.3, 1.0, 3.0, 12];   // 亿美元
const PC_BREAKS = [1.0, 2.5, 5.0, 12];  // 美元 / 人
const N_BREAKS = [0.3, 1.0, 3.0, 12];   // 等量亿美元（以中国零售价计）
const G_BREAKS = [0.05, 0.2, 0.6, 2.5]; // 毛利池，亿美元

/* 零售价拆解出来的五段，颜色从厂端到税一路变冷 */
const SLICES = [
  { k: "F",    c: "#6FD8CF", label: "厂端结算" },
  { k: "duty", c: "#E2445C", label: "关税" },
  { k: "frt",  c: "#E8A33D", label: "头程物流" },
  { k: "chan", c: "#5E6675", label: "渠道加价" },
  { k: "tax",  c: "#3B424C", label: "当地税" },
];
const ROLE = {
  ip:       { c: "#E2445C", label: "IP・原型策源" },
  mfg:      { c: "#E8A33D", label: "制造中枢" },
  core:     { c: "#3FA9C9", label: "成熟消费市场" },
  emerging: { c: "#7BC043", label: "高增长新兴" },
};
const NODEKIND = {
  expo: { label: "展会" }, factory: { label: "制造" },
  hq: { label: "总部" }, hub: { label: "零售集散" },
};
/* bars 指这个视图配哪一份排行榜——产业分工沿用规模排名 */
const VIEWS = [
  { id: "m", k: "01 / VOLUME", label: "市场总量", bars: "m" },
  { id: "pc", k: "02 / DENSITY", label: "人均浓度", bars: "pc" },
  { id: "role", k: "03 / ROLE", label: "产业分工", bars: "m" },
  { id: "n", k: "04 / UNITS", label: "价格校正", bars: "n" },
  { id: "g", k: "05 / MARGIN", label: "毛利池", bars: "g" },
];
/* 110m 底图上小到看不见、但有数据的地方，画成方块 */
const MICRO = [["Hong Kong", 114.17, 22.32], ["Singapore", 103.82, 1.35]];

/* ---------- Miller 圆柱投影，与烘好的 path 坐标一致 ---------- */
const Y_TOP = 1.9792831982587835, SC = 159.15494309189535;
function P(lon, lat) {
  lat = Math.max(-58, Math.min(83.5, lat));
  const x = (lon + 180) / 360 * 1000;
  const yy = 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * lat * Math.PI / 180));
  return [x, (Y_TOP - yy) * SC];
}

const esc = s => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

/* ---------- 沿 180° 经线切开跨越东西经的国家 ----------
 *
 * 底图烘成平面坐标时没有在反经线上裁断，于是俄罗斯（楚科奇半岛）和斐济这类
 * 横跨 180° 的多边形里，同一个环既有 x≈1000 的点又有 x≈0 的点。直接画出来，
 * 那条本该绕到地图另一侧的边会被拉成一条贯穿全图的横带。
 *
 * 这里把每个环拆成绝对坐标点列，凡是相邻两点的横向跳跃超过半幅图，就认定它
 * 跨了反经线：在图幅边缘补一个插值点收尾，另一侧从对应边缘重新起笔。
 */
const W = 1000;             // 图幅宽度，即整整 360° 经度
const WRAP = W / 2;         // 跳跃超过半幅图就认为是绕过了反经线

function parseSubpath(sub) {
  const nums = sub.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const pts = [[nums[0], nums[1]]];
  for (let i = 2; i < nums.length; i += 2) {
    const [px, py] = pts[pts.length - 1];
    pts.push([px + nums[i], py + nums[i + 1]]);
  }
  return pts;
}

/* 一段跨了反经线时，算出它在图幅边缘的进出点：两者纵坐标相同，
   出点贴着离开的那条边，进点贴着另一条边 */
function edgePair([x0, y0], [x1, y1]) {
  const east = x1 < x0;                       // 从右边缘出去，左边缘进来
  const out = east ? W : 0, into = east ? 0 : W;
  const dx = east ? x1 + W - x0 : x1 - W - x0;
  const t = dx === 0 ? 0 : (out - x0) / dx;   // 点正好落在边上时不用插值
  const yc = y0 + t * (y1 - y0);
  return [[out, yc], [into, yc]];
}

function cutRing(pts) {
  /* 环是闭合的，路径里显式回到起点的那个重复点先去掉 */
  const last = pts[pts.length - 1];
  if (pts.length > 1 && last[0] === pts[0][0] && last[1] === pts[0][1]) pts.pop();

  const n = pts.length;
  const crosses = i => Math.abs(pts[(i + 1) % n][0] - pts[i][0]) > WRAP;
  const first = [...Array(n).keys()].find(crosses);
  if (first === undefined) return [pts];

  /* 从第一个跨越之后起笔，这样绕一圈回来时最后一段正好是那次跨越，
     不会出现「首尾两段其实是同一块陆地」却被拆开的情况 */
  const start = (first + 1) % n;
  const runs = [];
  let run = [edgePair(pts[first], pts[start])[1]];
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n, j = (start + k + 1) % n;
    run.push(pts[i]);
    if (Math.abs(pts[j][0] - pts[i][0]) > WRAP) {
      const [out, into] = edgePair(pts[i], pts[j]);
      run.push(out);
      runs.push(run);
      run = [into];
    }
  }
  /* 循环最后一步已经收尾并另起了一笔，那一笔和开头重复，丢掉 */
  return runs.filter(r => {
    if (r.length < 3) return false;
    const xs = r.map(p => p[0]), ys = r.map(p => p[1]);
    /* 切出来的零宽零高碎片不画 */
    return Math.max(...xs) - Math.min(...xs) > 0.05 && Math.max(...ys) - Math.min(...ys) > 0.05;
  });
}

/* 点列写回紧凑的相对坐标 path，和原始数据同一种写法 */
function serialize(pts) {
  const r = n => Math.round(n * 10) / 10;
  let [px, py] = pts[0];
  let d = `M${r(px)} ${r(py)}l`;
  const segs = [];
  for (let i = 1; i < pts.length; i++) {
    segs.push(`${r(pts[i][0] - px)} ${r(pts[i][1] - py)}`);
    [px, py] = pts[i];
  }
  return d + segs.join(",") + "z";
}

function cutAtAntimeridian(d) {
  return d.split("M").filter(Boolean)
    .flatMap(sub => cutRing(parseSubpath("M" + sub)))
    .map(serialize).join("");
}

/* 值落在第几档 */
const band = (v, breaks) => { let i = 0; while (i < breaks.length && v >= breaks[i]) i++; return i; };

const entries = Object.entries(DATA);
const TOTAL = entries.reduce((a, [, d]) => a + d.m, 0);

/* ---------- 零售价拆解：从销售额推到「买走多少件」和「厂端赚到多少」 ----------
 *
 * 含税零售价  P = 出厂价 F × (1 + 关税 d + 头程 f) × 渠道倍数 M × (1 + 税 vat)
 *
 * 各市场的 P 是观测值（以中国大陆同款零售价为 1），反解出来的 F 就是同一件东西
 * 卖到当地时厂端实际结算到的钱。制造成本 C 与卖到哪里无关——东西都出自同一批
 * 工厂——所以单件毛利 = F − C，乘以等量件数就是这个市场的毛利池。
 *
 * 销售额大不等于赚得多：高价市场的价差有很大一块被当地税和渠道吃掉，
 * 低价市场则是件数多、单件薄。这一层就是把这两件事分开看。
 */
const C = COST.cost;
const CLUSTER = {};                       // 国名 -> 分组
for (const [key, cl] of Object.entries(COST.clusters))
  for (const name of cl.members) {
    if (!DATA[name]) throw new Error(`成本模型里的 ${name} 不在国别数据里`);
    CLUSTER[name] = key;
  }

const CL = {};                            // 分组 -> 派生量
for (const [key, cl] of Object.entries(COST.clusters)) {
  const { P, vat, d, f, M } = cl;
  const s = 1 / ((1 + d + f) * M * (1 + vat));   // 厂端结算占零售价的比例
  const F = s * P;                                // 单件厂端结算，以中国零售价为 1
  const slice = {
    F: s, duty: s * d, frt: s * f,
    chan: s * (1 + d + f) * (M - 1),
    tax: vat / (1 + vat),
  };
  const sum = Object.values(slice).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 1e-9) throw new Error(`${key} 的零售价拆解加起来是 ${sum}，不是 1`);
  CL[key] = { ...cl, key, s, F, unit: F - C, slice };
}

const MODEL = {};                         // 国名 -> {分组, 等量销售额, 毛利池}
for (const [name, d] of entries) {
  const cl = CL[CLUSTER[name]];
  if (!cl) throw new Error(`${name} 没有归进任何成本模型分组`);
  const n = d.m / cl.P;                   // 按中国零售价重新计价的等量销售额
  MODEL[name] = { cl, n, g: n * cl.unit };
}
const TOTAL_N = entries.reduce((a, [name]) => a + MODEL[name].n, 0);
const TOTAL_G = entries.reduce((a, [name]) => a + MODEL[name].g, 0);

/* 每个国家身上挂全部五套配色的档位类，视图切换时由 CSS 决定用哪一套 */
function bandClasses(name) {
  const d = DATA[name];
  if (!d) return "";
  const m = MODEL[name];
  return ` b-m-${band(d.m, M_BREAKS)} b-pc-${band(d.pc, PC_BREAKS)} r-${d.role}` +
    ` b-n-${band(m.n, N_BREAKS)} b-g-${band(m.g, G_BREAKS)}`;
}
function titleFor(name) {
  const d = DATA[name];
  if (!d) return `${esc(name)} · 暂无估算`;
  const m = MODEL[name];
  return `${esc(d.zh)} · ${esc(name)} · ${d.m.toFixed(2)} 亿美元 · 人均 ${d.pc.toFixed(2)} 美元` +
    ` · 等量 ${m.n.toFixed(2)} · 毛利池 ${m.g.toFixed(2)}`;
}

/* ---------- 视图配色 CSS ---------- */
function viewCss() {
  const out = [];
  const paint = (sel, c) => `${sel}{fill:${c};background:${c}}`;

  RAMP_M.forEach((c, i) => out.push(paint(`#v-m:checked ~ .grid .b-m-${i}`, c)));
  RAMP_PC.forEach((c, i) => out.push(paint(`#v-pc:checked ~ .grid .b-pc-${i}`, c)));
  RAMP_N.forEach((c, i) => out.push(paint(`#v-n:checked ~ .grid .b-n-${i}`, c)));
  RAMP_G.forEach((c, i) => out.push(paint(`#v-g:checked ~ .grid .b-g-${i}`, c)));
  Object.entries(ROLE).forEach(([k, v]) => out.push(paint(`#v-role:checked ~ .grid .r-${k}`, v.c)));

  /* 选中的标签页 */
  out.push(VIEWS.map(v => `#v-${v.id}:checked ~ .grid label[for="v-${v.id}"]`).join(",\n") +
    "{color:var(--ink);background:var(--panel2)}");
  out.push(VIEWS.map(v => `#v-${v.id}:checked ~ .grid label[for="v-${v.id}"]::before`).join(",\n") +
    "{content:\"\";position:absolute;left:0;right:0;top:0;height:2px;background:var(--ink)}");

  /* 每个视图各自的图例、排行榜与标题 */
  VIEWS.forEach(v => {
    out.push(`#v-${v.id}:checked ~ .grid .leg-${v.id}{display:block}`);
  });
  out.push(VIEWS.map(v => `#v-${v.id}:checked ~ .grid .barset-${v.bars}`).join(",\n") + "{display:block}");
  out.push(VIEWS.map(v => `#v-${v.id}:checked ~ .grid .btitle-${v.bars}`).join(",\n") + "{display:block}");

  /* 角色筛选：只在产业分工视图里生效，被排除的地区压暗 */
  Object.keys(ROLE).forEach(k => {
    out.push(`#v-role:checked ~ #rf-${k}:checked ~ .grid .c:not(.r-${k}){opacity:.28}`);
    out.push(`#rf-${k}:checked ~ .grid label[for="rf-${k}"]{color:var(--ink)}`);
  });
  out.push(`#rf-all:checked ~ .grid label[for="rf-all"]{color:var(--ink)}`);

  /* 键盘焦点圈：单选框本身是隐藏的，把圈画到它的标签上 */
  out.push(VIEWS.map(v => `#v-${v.id}:focus-visible ~ .grid label[for="v-${v.id}"]`).join(",\n") +
    "{outline:2px solid var(--focus);outline-offset:-2px}");
  out.push(["all", ...Object.keys(ROLE)].map(k => `#rf-${k}:focus-visible ~ .grid label[for="rf-${k}"]`).join(",\n") +
    "{outline:2px solid var(--focus);outline-offset:2px}");

  return out.join("\n");
}

/* ---------- 单选框 + 标签页 ---------- */
const radios = [
  ...VIEWS.map((v, i) =>
    `<input class="vsel" type="radio" name="view" id="v-${v.id}"${i === 0 ? " checked" : ""}>`),
  `<input class="vsel" type="radio" name="rolefilter" id="rf-all" checked>`,
  ...Object.keys(ROLE).map(k =>
    `<input class="vsel" type="radio" name="rolefilter" id="rf-${k}">`),
].join("\n");

const tabs = VIEWS.map(v =>
  `      <label class="tab" for="v-${v.id}"><span class="k">${esc(v.k)}</span>${esc(v.label)}</label>`
).join("\n");

/* ---------- 地图：陆地 ---------- */
const lands = [
  ...Object.entries(WORLD).map(([name, d]) => {
    const cut = cutAtAntimeridian(d);
    /* 切完之后不该再有横跨半幅图的环，有就是切漏了 */
    for (const sub of cut.split("M").filter(Boolean)) {
      const xs = parseSubpath("M" + sub).map(p => p[0]);
      const span = Math.max(...xs) - Math.min(...xs);
      if (span > WRAP) throw new Error(`${name} 仍有横跨 ${span.toFixed(0)}px 的路径，反经线没切干净`);
    }
    return `        <path class="c${bandClasses(name)}" d="${cut}" data-name="${esc(name)}"><title>${titleFor(name)}</title></path>`;
  }),
  ...MICRO.map(([name, lon, lat]) => {
    const [x, y] = P(lon, lat);
    return `        <rect class="c${bandClasses(name)}" x="${(x - 2.4).toFixed(2)}" y="${(y - 2.4).toFixed(2)}"` +
      ` width="4.8" height="4.8" data-name="${esc(name)}"><title>${titleFor(name)}</title></rect>`;
  }),
].join("\n");

/* ---------- 地图：城市节点，画成印刷/翻模用的定位标记 ---------- */
function markGlyph(kind, x, y) {
  const f = n => n.toFixed(2);
  if (kind === "expo") {
    return `<line x1="${f(x - 4.2)}" y1="${f(y)}" x2="${f(x + 4.2)}" y2="${f(y)}"/>` +
      `<line x1="${f(x)}" y1="${f(y - 4.2)}" x2="${f(x)}" y2="${f(y + 4.2)}"/>` +
      `<circle cx="${f(x)}" cy="${f(y)}" r="2.3"/>`;
  }
  if (kind === "factory") return `<rect x="${f(x - 2.1)}" y="${f(y - 2.1)}" width="4.2" height="4.2"/>`;
  if (kind === "hq") return `<polygon points="${f(x)},${f(y - 2.7)} ${f(x + 2.6)},${f(y + 2.1)} ${f(x - 2.6)},${f(y + 2.1)}"/>`;
  return `<circle cx="${f(x)}" cy="${f(y)}" r="2.4"/>`;
}
const nodeMarks = NODES.map((n, i) => {
  const [x, y] = P(n.lon, n.lat);
  return `        <g class="node">${markGlyph(n.kind, x, y)}</g>\n` +
    `        <circle class="nodehit" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="9" data-node="${i}">` +
    `<title>${esc(n.zh)} · ${esc(NODEKIND[n.kind].label)}</title></circle>`;
}).join("\n");

/* ---------- 图例 ---------- */
function bandLabels(breaks) {
  const out = [`<${breaks[0]}`];
  for (let i = 0; i < breaks.length - 1; i++) out.push(`${breaks[i]}–${breaks[i + 1]}`);
  out.push(`${breaks[breaks.length - 1]}+`);
  return out;
}
function rampLegend(id, title, unit, ramp, breaks) {
  const labels = bandLabels(breaks);
  const chips = ramp.map((c, i) =>
    `<div class="chip"><div class="sw" style="background:${c}"></div><div class="lb">${esc(labels[i])}</div></div>`
  ).join("");
  return `      <div class="leg leg-${id}">
        <div class="legtitle">${esc(title)} · ${esc(unit)}</div>
        <div class="chips">${chips}</div>
      </div>`;
}
const roleLegend = `      <div class="leg leg-role">
        <div class="legtitle">产业角色 / Role</div>
        <div class="cats">
          <label class="cat" for="rf-all"><i style="background:transparent;border-color:var(--muted)"></i>全部</label>
${Object.entries(ROLE).map(([k, v]) =>
  `          <label class="cat" for="rf-${k}"><i style="background:${v.c}"></i>${esc(v.label)}</label>`).join("\n")}
        </div>
      </div>`;
const marksLegend = `      <div class="legright">
        <div class="legtitle">城市节点</div>
        <div class="marks">
          <span><svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true"><g stroke="#EDE9E0" stroke-width="1" fill="none"><line x1="-4.2" y1="0" x2="4.2" y2="0"/><line x1="0" y1="-4.2" x2="0" y2="4.2"/><circle r="2.3"/></g></svg>展会</span>
          <span><svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true"><rect x="-2.1" y="-2.1" width="4.2" height="4.2" fill="#EDE9E0"/></svg>制造</span>
          <span><svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true"><polygon points="0,-2.7 2.6,2.1 -2.6,2.1" fill="#EDE9E0"/></svg>总部</span>
          <span><svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true"><circle r="2.4" fill="none" stroke="#EDE9E0" stroke-width="1"/></svg>集散</span>
        </div>
      </div>`;
const legend = [
  rampLegend("m", "市场规模", "亿美元", RAMP_M, M_BREAKS),
  rampLegend("pc", "人均年消费", "美元 / 人", RAMP_PC, PC_BREAKS),
  rampLegend("n", "等量销售额 · 按中国零售价重新计价", "亿美元", RAMP_N, N_BREAKS),
  rampLegend("g", "厂端毛利池 · 扣完税费渠道与制造成本", "亿美元", RAMP_G, G_BREAKS),
  roleLegend,
  marksLegend,
].join("\n");

/* ---------- 排行榜：每份口径各一榜，产业分工视图沿用规模排名 ---------- */
const METRIC = {
  m:  { of: name => DATA[name].m,     dp: 1, unit: "规模", title: "规模排名 / Top 10 by volume" },
  pc: { of: name => DATA[name].pc,    dp: 1, unit: "人均", title: "人均排名 / Top 10 by density" },
  n:  { of: name => MODEL[name].n,    dp: 1, unit: "等量", title: "等量排名 / Top 10 by units" },
  g:  { of: name => MODEL[name].g,    dp: 2, unit: "毛利池", title: "毛利池排名 / Top 10 by margin" },
};
function barset(id) {
  const { of, dp, unit } = METRIC[id];
  const list = [...entries].sort((a, b) => of(b[0]) - of(a[0])).slice(0, 10);
  const max = of(list[0][0]);
  const rows = list.map(([name, d]) =>
    `        <div class="bar" data-n="${esc(name)}">
          <div class="t"><span>${esc(d.zh)}</span><b>${of(name).toFixed(dp)}</b></div>
          <div class="tr"><div class="fl${bandClasses(name)}" style="width:${(of(name) / max * 100).toFixed(1)}%"></div></div>
        </div>`).join("\n");
  return `      <div class="barset barset-${id}" aria-label="按${unit}排名前十">\n${rows}\n      </div>`;
}
const barKeys = [...new Set(VIEWS.map(v => v.bars))];
const bars = barKeys.map(barset).join("\n");
const barTitles = barKeys.map(k =>
  `      <h2 class="btitle btitle-${k}">${esc(METRIC[k].title)}</h2>`).join("\n");

/* ---------- 价格拆解：每个分组的零售价怎么分掉的 ---------- */
const breakdown = Object.values(CL).map(cl => `        <div class="firm">
          <div class="fn">${esc(cl.zh)}<span class="pmul">零售价 ×${cl.P.toFixed(2)}</span></div>
          <div class="fm">厂端结算 ${(cl.s * 100).toFixed(0)}% · 单件到手 ${cl.F.toFixed(2)} · 单件毛利 ${cl.unit.toFixed(2)}</div>
          <div class="stack">${SLICES.map(s =>
            `<div style="width:${(cl.slice[s.k] * 100).toFixed(1)}%;background:${s.c}" title="${esc(s.label)} ${(cl.slice[s.k] * 100).toFixed(1)}%"></div>`).join("")}</div>
          <div class="fk">${SLICES.filter(s => cl.slice[s.k] > 0.005).map(s =>
            `<span><i style="background:${s.c}"></i>${esc(s.label)} ${(cl.slice[s.k] * 100).toFixed(0)}%</span>`).join("")}</div>${cl.note ? `
          <div class="fnote">${esc(cl.note)}</div>` : ""}
        </div>`).join("\n");

/* ---------- 厂商 ---------- */
const firms = FIRMS.map(f => `        <div class="firm">
          <div class="fn">${esc(f.n)}</div>
          <div class="fm">${esc(f.m)}</div>${f.seg ? `
          <div class="stack">${f.seg.map(([, v, c]) => `<div style="width:${v}%;background:${c}"></div>`).join("")}</div>
          <div class="fk">${f.seg.map(([l, v, c]) => `<span><i style="background:${c}"></i>${esc(l)} ${v}%</span>`).join("")}</div>` : ""}
          <div class="fnote">${esc(f.note)}</div>
        </div>`).join("\n");

/* ---------- 节点列表 ---------- */
const nodeList = NODES.map((n, i) =>
  `        <div class="nl" data-i="${i}"><div class="g">${esc(NODEKIND[n.kind].label)}</div>
        <div><div class="n">${esc(n.zh)}</div><div class="d">${esc(n.d)}</div></div></div>`).join("\n");

/* ---------- 全量数据表 ---------- */
const rows = [...entries].sort((a, b) => b[1].m - a[1].m).map(([name, d]) => {
  const m = MODEL[name];
  return `        <tr data-n="${esc(name)}">
          <td class="geo"><b>${esc(d.zh)}</b><span class="lat">${esc(name)}</span></td>
          <td class="num">${d.m.toFixed(2)}</td>
          <td class="num">${d.pc.toFixed(2)}</td>
          <td class="num">${m.cl.P.toFixed(2)}</td>
          <td class="num">${m.n.toFixed(2)}</td>
          <td class="num">${m.g.toFixed(2)}</td>
          <td class="num">${(m.g / TOTAL_G * 100).toFixed(1)}%</td>
          <td class="rl"><i style="background:${ROLE[d.role].c}"></i>${esc(ROLE[d.role].label)}</td>
          <td class="desc">${d.note ? esc(d.note) : "—"}</td>
        </tr>`;
}).join("\n");

/* 模型参数摊开，愿意的话可以逐个跟我吵 */
const paramRows = Object.values(CL).map(cl =>
  `        <tr>
          <td class="geo"><b>${esc(cl.zh)}</b></td>
          <td class="num">${cl.P.toFixed(2)}</td>
          <td class="num">${(cl.vat * 100).toFixed(0)}%</td>
          <td class="num">${(cl.d * 100).toFixed(0)}%</td>
          <td class="num">${(cl.f * 100).toFixed(0)}%</td>
          <td class="num">${cl.M.toFixed(2)}</td>
          <td class="num">${(cl.s * 100).toFixed(1)}%</td>
          <td class="num">${cl.F.toFixed(3)}</td>
          <td class="num">${cl.unit.toFixed(3)}</td>
        </tr>`).join("\n");

/* ---------- 填模板 ---------- */
const fills = {
  __VIEWCSS__: viewCss(),
  __RADIOS__: radios,
  __TABS__: tabs,
  __LANDS__: lands,
  __NODEMARKS__: nodeMarks,
  __LEGEND__: legend,
  __BARTITLES__: barTitles,
  __BARS__: bars,
  __FIRMS__: firms,
  __BREAKDOWN__: breakdown,
  __NODELIST__: nodeList,
  __ROWS__: rows,
  __PARAMROWS__: paramRows,
  __COUNT__: String(entries.length),
  __TOTAL__: TOTAL.toFixed(2),
  __TOTALN__: TOTAL_N.toFixed(2),
  __TOTALG__: TOTAL_G.toFixed(2),
  __COST__: C.toFixed(2),
  __GSHARE__: (TOTAL_G / TOTAL * 100).toFixed(1),
  __MODEL_JSON__: JSON.stringify(Object.fromEntries(
    entries.map(([name]) => [name, {
      P: +MODEL[name].cl.P.toFixed(2), zh: MODEL[name].cl.zh,
      s: +MODEL[name].cl.s.toFixed(4), F: +MODEL[name].cl.F.toFixed(3),
      n: +MODEL[name].n.toFixed(3), g: +MODEL[name].g.toFixed(3),
    }]))),
  __DATA_JSON__: JSON.stringify(DATA),
  __NODES_JSON__: JSON.stringify(NODES),
  __ROLE_JSON__: JSON.stringify(ROLE),
  __NODEKIND_JSON__: JSON.stringify(NODEKIND),
};

let html = fs.readFileSync(path.join(DIR, "template.html"), "utf8");
for (const [mark, value] of Object.entries(fills)) {
  html = html.split(mark).join(value);
}
for (const mark of Object.keys(fills)) {
  if (html.includes(mark)) throw new Error(`template.html 里的 ${mark} 没有被替换`);
}
/* 单文件、零外部请求是这个页面的硬要求，顺手守住 */
const remote = html.match(/(?:src|href)="https?:\/\/[^"]+"/g);
if (remote) throw new Error(`页面引用了外部资源：${remote.join(", ")}`);

fs.writeFileSync(path.join(DIR, "index.html"), html);
console.log(`index.html：${entries.length} 个国家/地区，${NODES.length} 个节点，` +
  `合计 ${TOTAL.toFixed(2)} 亿美元，${(html.length / 1024).toFixed(0)} KB`);
