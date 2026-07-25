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

/* ---------- 配色与分级：全站唯一一份，CSS 和 JS 都从这里派生 ---------- */
const RAMP_M = ["#3A424C", "#255A72", "#1E7C99", "#2FA6BC", "#6FD8CF"];
const RAMP_PC = ["#413F3A", "#6E5330", "#A6762C", "#D9A230", "#F3D45F"];
const M_BREAKS = [0.3, 1.0, 3.0, 12];   // 亿美元
const PC_BREAKS = [1.0, 2.5, 5.0, 12];  // 美元 / 人
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
const VIEWS = [
  { id: "m", k: "01 / VOLUME", label: "市场总量" },
  { id: "pc", k: "02 / DENSITY", label: "人均浓度" },
  { id: "role", k: "03 / ROLE", label: "产业分工" },
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

/* 值落在第几档 */
const band = (v, breaks) => { let i = 0; while (i < breaks.length && v >= breaks[i]) i++; return i; };

const entries = Object.entries(DATA);
const TOTAL = entries.reduce((a, [, d]) => a + d.m, 0);

/* 每个国家身上挂三套配色的档位类，视图切换时由 CSS 决定用哪一套 */
function bandClasses(name) {
  const d = DATA[name];
  if (!d) return "";
  return ` b-m-${band(d.m, M_BREAKS)} b-pc-${band(d.pc, PC_BREAKS)} r-${d.role}`;
}
function titleFor(name) {
  const d = DATA[name];
  if (!d) return `${esc(name)} · 暂无估算`;
  return `${esc(d.zh)} · ${esc(name)} · ${d.m.toFixed(2)} 亿美元 · 人均 ${d.pc.toFixed(2)} 美元`;
}

/* ---------- 视图配色 CSS ---------- */
function viewCss() {
  const out = [];
  const paint = (sel, c) => `${sel}{fill:${c};background:${c}}`;

  RAMP_M.forEach((c, i) => out.push(paint(`#v-m:checked ~ .grid .b-m-${i}`, c)));
  RAMP_PC.forEach((c, i) => out.push(paint(`#v-pc:checked ~ .grid .b-pc-${i}`, c)));
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
  out.push(`#v-m:checked ~ .grid .barset-m,\n#v-role:checked ~ .grid .barset-m,\n#v-pc:checked ~ .grid .barset-pc{display:block}`);
  out.push(`#v-m:checked ~ .grid .btitle-m,\n#v-role:checked ~ .grid .btitle-m,\n#v-pc:checked ~ .grid .btitle-pc{display:block}`);

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
  ...Object.entries(WORLD).map(([name, d]) =>
    `        <path class="c${bandClasses(name)}" d="${d}" data-name="${esc(name)}"><title>${titleFor(name)}</title></path>`),
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
  roleLegend,
  marksLegend,
].join("\n");

/* ---------- 排行榜：两个视图各一份，产业分工视图沿用规模排名 ---------- */
function barset(id, key, unit) {
  const list = [...entries].sort((a, b) => b[1][key] - a[1][key]).slice(0, 10);
  const max = list[0][1][key];
  const rows = list.map(([name, d]) =>
    `        <div class="bar" data-n="${esc(name)}">
          <div class="t"><span>${esc(d.zh)}</span><b>${d[key].toFixed(1)}</b></div>
          <div class="tr"><div class="fl b-m-${band(d.m, M_BREAKS)} b-pc-${band(d.pc, PC_BREAKS)} r-${d.role}" style="width:${(d[key] / max * 100).toFixed(1)}%"></div></div>
        </div>`).join("\n");
  return `      <div class="barset barset-${id}" aria-label="按${unit}排名前十">\n${rows}\n      </div>`;
}
const bars = [barset("m", "m", "规模"), barset("pc", "pc", "人均")].join("\n");
const barTitles =
  `      <h2 class="btitle btitle-m">规模排名 / Top 10 by volume</h2>\n` +
  `      <h2 class="btitle btitle-pc">人均排名 / Top 10 by density</h2>`;

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
const rows = [...entries].sort((a, b) => b[1].m - a[1].m).map(([name, d]) =>
  `        <tr data-n="${esc(name)}">
          <td class="geo"><b>${esc(d.zh)}</b><span class="lat">${esc(name)}</span></td>
          <td class="num">${d.m.toFixed(2)}</td>
          <td class="num">${d.pc.toFixed(2)}</td>
          <td class="num">${(d.m / TOTAL * 100).toFixed(1)}%</td>
          <td class="rl"><i style="background:${ROLE[d.role].c}"></i>${esc(ROLE[d.role].label)}</td>
          <td class="desc">${d.note ? esc(d.note) : "—"}</td>
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
  __NODELIST__: nodeList,
  __ROWS__: rows,
  __COUNT__: String(entries.length),
  __TOTAL__: TOTAL.toFixed(2),
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
