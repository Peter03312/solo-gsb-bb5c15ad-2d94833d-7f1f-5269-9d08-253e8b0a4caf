'use strict';

// 草稿修订时间线的端到端 HTTP 自测（npm test）：在临时 DATA_DIR 上启动真实服务，覆盖
//   上传即基线 → 定标/轮廓/视野/迁移各留修订 → 预览（标尺/轮廓/视野/统计）
//   → 恢复（带版本）→ 新版本新修订、不抹历史、按恢复标尺重算测量与视野统计
//   → 版本过期 409、修订不存在/不属于该切片 404 → 失败请求不留修订
//   → 已发布报告与更正链不受恢复影响 → 旧库启动补录基线。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const sharp = require('sharp');

const PORT = 8237;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-rev-'));
const base = `http://localhost:${PORT}`;
let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('ok -', name); }
  else { failures += 1; console.error('FAIL -', name, extra != null ? JSON.stringify(extra) : ''); }
}

async function jget(p) {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function jsend(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function upload(buffer) {
  return new Promise((resolve, reject) => {
    const boundary = '----b' + Math.random().toString(16).slice(2);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\n` +
      'Content-Type: image/png\r\n\r\n');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const req = require('http').request(base + '/api/images', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': head.length + buffer.length + tail.length }
    }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }));
    });
    req.on('error', reject);
    req.write(head); req.write(buffer); req.write(tail); req.end();
  });
}

const square = (x, y, w) => ({
  outer: [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + w }, { x, y: y + w }
  ], holes: []
});

async function revisionsOf(imgId) {
  return (await jget(`/api/images/${imgId}/revisions`)).body;
}
async function revisionCount(imgId) {
  return (await revisionsOf(imgId)).count;
}

function startServer(env = {}) {
  return spawn(process.execPath, [path.join(__dirname, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function waitReady(srv) {
  let started = false;
  srv.stdout.on('data', (d) => { if (String(d).includes('已启动')) started = true; });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 50 && !started; i++) await new Promise((r) => setTimeout(r, 100));
  if (!started) throw new Error('server did not start');
}

async function main() {
  const srv = startServer();
  await waitReady(srv);

  try {
    const png = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#ffffff' } })
      .png().toBuffer();
    const up = await upload(png);
    check('上传图片成功', up.status === 201, up);
    const imgId = up.body.id;

    // 新上传草稿即有一条 v1 基线修订
    let tl = await revisionsOf(imgId);
    check('上传后即有 1 条修订', tl.count === 1, tl);
    check('基线修订 v1/baseline', tl.revisions[0].version === 1 && tl.revisions[0].kind === 'baseline', tl.revisions[0]);
    check('列表 currentVersion 正确', tl.currentVersion === 1);
    check('基线标记为当前', tl.revisions[0].isCurrent === true);
    const baseRevId = tl.revisions[0].id;

    // 基线详情可预览：未定标、无细胞、无视野
    let d = (await jget(`/api/images/${imgId}/revisions/${baseRevId}`)).body;
    check('基线详情 200 且 calib=null', d.id === baseRevId && d.calib === null, d);
    check('基线详情 cells/fields 为空', Array.isArray(d.cells) && d.cells.length === 0 && d.fields.length === 0);
    check('基线详情 fieldStats 为空数组', Array.isArray(d.fieldStats) && d.fieldStats.length === 0);
    check('基线详情带图片尺寸', d.width === 400 && d.height === 300);
    check('基线详情类型标签', d.kindLabel === '基线');

    // ---- 定标成功 → 修订 v2 calibration ----
    let r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    check('定标 200', r.status === 200, r.body && r.body.error);
    check('定标后版本 v2', r.body.version === 2);
    tl = await revisionsOf(imgId);
    check('定标后修订数=2', tl.count === 2, tl);
    check('最新修订为 calibration v2',
      tl.revisions[0].version === 2 && tl.revisions[0].kind === 'calibration', tl.revisions[0]);
    check('v2 标记当前、v1 非当前',
      tl.revisions[0].isCurrent === true && tl.revisions[1].isCurrent === false);
    const calRevId = tl.revisions[0].id;

    // 定标失败（两点重合）→ 400 不留修订、版本不变
    const beforeFail = await revisionCount(imgId);
    r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: 2, p1: { x: 5, y: 5 }, p2: { x: 5, y: 5 }, distanceUm: 100
    });
    check('非法定标 400', r.status === 400, r.body);
    check('失败请求不留修订', await revisionCount(imgId) === beforeFail);
    check('失败请求版本不变', (await jget(`/api/images/${imgId}`)).body.version === 2);

    // 定标版本过期 → 409 不留修订
    r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 200
    });
    check('定标版本过期 409', r.status === 409 && r.body.currentVersion === 2, r.body);
    check('409 不留修订', await revisionCount(imgId) === beforeFail);

    // ---- 保存轮廓：一个 100×100 正方形细胞，scale=1 → 10000 μm² ----
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: 2, cells: [{ id: 'cell-1', name: '细胞1', ...square(10, 10, 100) }]
    });
    check('保存轮廓 200', r.status === 200, r.body && r.body.error);
    const v3 = r.body.version;
    check('轮廓版本 v3', v3 === 3);
    check('细胞测量按 scale=1', Math.abs(r.body.cells[0].areaUm2 - 10000) < 1e-6, r.body.cells[0]);
    const tlAfterContours = await revisionsOf(imgId);
    check('轮廓后修订数=3', tlAfterContours.count === 3);
    check('最新修订 contours', tlAfterContours.revisions[0].kind === 'contours');
    const contoursRevId = tlAfterContours.revisions[0].id;

    // 非法轮廓（顶点不足）→ 400 整批不生效、不留修订
    const beforeBadContour = await revisionCount(imgId);
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: v3,
      cells: [{ id: 'bad', name: '坏', outer: [{ x: 0, y: 0 }, { x: 1, y: 1 }], holes: [] }]
    });
    check('非法轮廓 400', r.status === 400, r.body);
    check('非法轮廓不留修订', await revisionCount(imgId) === beforeBadContour);

    // ---- 保存视野：覆盖细胞质心 (60,60) ----
    r = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: v3,
      fields: [{ id: 'f1', name: '视野1', ...square(0, 0, 200) }]
    });
    check('保存视野 200', r.status === 200, r.body && r.body.error);
    const v4 = r.body.version;
    check('视野版本 v4', v4 === 4);
    check('视野统计实时给出细胞数 1', r.body.fieldStats[0].cellCount === 1, r.body.fieldStats[0]);
    let tlV4 = await revisionsOf(imgId);
    check('视野后修订数=4', tlV4.count === 4);
    check('最新修订 fields', tlV4.revisions[0].kind === 'fields');
    const fieldsRevId = tlV4.revisions[0].id;

    // ---- 发布报告（scale=1，面积 10000 μm² = 0.01 mm²）----
    r = await jsend('POST', `/api/images/${imgId}/publish`, { version: v4, title: '切片A 报告 scale1' });
    check('发布 201', r.status === 201, r.body && r.body.error);
    const rep1 = r.body.report;
    check('发布不产生草稿修订', (await revisionsOf(imgId)).count === 4);
    const v5 = r.body.image.version; // 发布推进版本但无修订；当前版本 v5 无对应修订

    // ---- 重新定标 scale=2，触发测量与视野统计重算 ----
    r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: v5, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 200
    });
    check('重定标 200', r.status === 200, r.body && r.body.error);
    const v6 = r.body.version;
    check('重定标后 scale=2', Math.abs(r.body.calib.scale - 2) < 1e-9);
    check('测量按 scale=2 重算（40000）', Math.abs(r.body.cells[0].areaUm2 - 40000) < 1e-6, r.body.cells[0]);
    check('视野统计按 scale=2（视野 200px=0.16 mm²，细胞净面积 0.04）',
      Math.abs(r.body.fieldStats[0].areaMm2 - 0.16) < 1e-9 &&
      Math.abs(r.body.fieldStats[0].countedCellAreaMm2 - 0.04) < 1e-9, r.body.fieldStats[0]);

    // 当前草稿（v6）与 contours 修订（v3，scale=1）标尺不同：恢复 v3 应重算回 scale=1
    const detailV3 = (await jget(`/api/images/${imgId}/revisions/${contoursRevId}`)).body;
    check('v3 修订预览 scale=1', Math.abs(detailV3.calib.scale - 1) < 1e-9, detailV3.calib);
    check('v3 修订预览无视野（保存视野之前）', detailV3.fields.length === 0);
    check('v3 修订预览含 1 个细胞（冻结测量 10000）',
      detailV3.cells.length === 1 && Math.abs(detailV3.cells[0].areaUm2 - 10000) < 1e-6);
    check('v3 非当前', detailV3.isCurrent === false);

    const fieldsDetail = (await jget(`/api/images/${imgId}/revisions/${fieldsRevId}`)).body;
    check('v4 修订预览含 1 视野与统计',
      fieldsDetail.fields.length === 1 && fieldsDetail.fieldStats.length === 1, fieldsDetail);
    check('v4 预览统计 scale=1（视野 0.04 mm²，细胞净面积 0.01，细胞 1）',
      Math.abs(fieldsDetail.fieldStats[0].areaMm2 - 0.04) < 1e-9 &&
      Math.abs(fieldsDetail.fieldStats[0].countedCellAreaMm2 - 0.01) < 1e-9 &&
      fieldsDetail.fieldStats[0].cellCount === 1, fieldsDetail.fieldStats[0]);

    // ---- 恢复过期版本 → 409，不写入 ----
    r = await jsend('POST', `/api/images/${imgId}/revisions/${contoursRevId}/restore`,
      { version: v4 });
    check('恢复携带过期版本 409', r.status === 409 && r.body.currentVersion === v6, r.body);
    check('409 不产生修订', (await revisionsOf(imgId)).count === 5);
    check('409 后当前草稿仍是 scale=2',
      Math.abs((await jget(`/api/images/${imgId}`)).body.calib.scale - 2) < 1e-9);

    // 缺少版本号 → 400
    r = await jsend('POST', `/api/images/${imgId}/revisions/${contoursRevId}/restore`, {});
    check('恢复缺版本号 400', r.status === 400, r.body);

    // ---- 恢复 contours 修订（v3, scale=1）为当前草稿 ----
    r = await jsend('POST', `/api/images/${imgId}/revisions/${contoursRevId}/restore`,
      { version: v6 });
    check('恢复 201', r.status === 201, r.body && r.body.error);
    const imgAfter = r.body.image;
    const v7 = imgAfter.version;
    check('恢复后版本 v7', v7 === 7, imgAfter);
    check('恢复携带来源信息',
      r.body.restoredFromRevisionId === contoursRevId && r.body.restoredFromVersion === 3, r.body);
    check('恢复生成 restore 新修订', r.body.revision.kind === 'restore' && r.body.revision.version === 7, r.body.revision);
    check('恢复后标尺回到 scale=1', Math.abs(imgAfter.calib.scale - 1) < 1e-9, imgAfter.calib);
    check('恢复后测量按恢复标尺重算（10000）',
      Math.abs(imgAfter.cells[0].areaUm2 - 10000) < 1e-6, imgAfter.cells[0]);
    check('恢复后视野回到修订时状态（无视野）', imgAfter.fields.length === 0, imgAfter.fields);
    check('恢复后视野统计为空', imgAfter.fieldStats.length === 0);

    // 后来的历史（scale=2 的 v6 修订）没有被抹掉
    tl = await revisionsOf(imgId);
    check('恢复不抹掉后来历史（共 6 条）', tl.count === 6, tl);
    const kinds = tl.revisions.map((x) => x.kind);
    check('历史含 restore / calibration / fields / contours / baseline',
      kinds.includes('restore') && kinds.includes('calibration') && kinds.includes('fields') &&
      kinds.includes('contours') && kinds.includes('baseline'), kinds);
    check('时间线按版本倒序', tl.revisions.map((x) => x.version).join() === '7,6,4,3,2,1',
      tl.revisions.map((x) => x.version));
    const restoreRow = tl.revisions[0];
    check('restore 修订记录来源', restoreRow.restoredFromRevisionId === contoursRevId, restoreRow);
    check('只有最新修订 isCurrent', restoreRow.isCurrent === true &&
      tl.revisions.slice(1).every((x) => x.isCurrent === false));

    // 已发布报告 rep1 不受恢复影响：仍是 scale=1 的冻结内容（本来就一样），且仍可读
    const rep1Check = (await jget(`/api/reports/${rep1.id}`)).body;
    check('已发布报告仍可读', rep1Check.id === rep1.id);
    check('已发布报告冻结测量不变（10000）', Math.abs(rep1Check.cells[0].areaUm2 - 10000) < 1e-6);

    // ---- 再次恢复到 v4（fields 修订，scale=1），随后重定标到 scale=3 验证统计重算 ----
    r = await jsend('POST', `/api/images/${imgId}/revisions/${fieldsRevId}/restore`,
      { version: v7 });
    check('恢复视野修订 201', r.status === 201, r.body && r.body.error);
    const v8 = r.body.image.version;
    check('恢复后视野回来（1 个）', r.body.image.fields.length === 1);
    r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: v8, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 300
    });
    check('再定标 scale=3 200', r.status === 200, r.body && r.body.error);
    check('scale=3 测量 90000', Math.abs(r.body.cells[0].areaUm2 - 90000) < 1e-6, r.body.cells[0]);
    check('scale=3 视野面积 0.36 mm²（细胞净面积 0.09）',
      Math.abs(r.body.fieldStats[0].areaMm2 - 0.36) < 1e-9 &&
      Math.abs(r.body.fieldStats[0].countedCellAreaMm2 - 0.09) < 1e-9, r.body.fieldStats[0]);
    const v9 = r.body.version;

    // 已发布报告 rep1 在 scale=3 之后仍是冻结的 10000 μm²（恢复/重定标不影响）
    const rep1After = (await jget(`/api/reports/${rep1.id}`)).body;
    check('重定标后已发布报告仍冻结 10000', Math.abs(rep1After.cells[0].areaUm2 - 10000) < 1e-6);

    // 更正链不受恢复影响：对 rep1 用当前草稿（scale=3）发起更正成功，新报告冻结 scale=3
    const rep1Trace = (await jget(`/api/reports/${rep1.id}/trace`)).body;
    r = await jsend('POST', `/api/reports/${rep1.id}/correct`, {
      reason: '恢复后重新定标，再发一版', draftVersion: v9, expectedTipId: rep1Trace.tipId
    });
    check('恢复后仍可发起更正 201', r.status === 201, r.body && r.body.error);
    const rep2 = r.body.report;
    check('更正新报告 scale=3', Math.abs(rep2.calib.scale - 3) < 1e-9, rep2.calib);
    check('更正新报告测量 90000', Math.abs(rep2.cells[0].areaUm2 - 90000) < 1e-6);
    check('更正链接续正确', rep2.correctsReportId === rep1.id);
    const rep1Trace2 = (await jget(`/api/reports/${rep1.id}/trace`)).body;
    check('更正链长度 2', rep1Trace2.length === 2 && rep1Trace2.tipId === rep2.id);

    // ---- 修订不存在 / 不属于该切片 ----
    r = await jget(`/api/images/${imgId}/revisions/nonexistent-id`);
    check('修订不存在 404', r.status === 404, r.body);
    r = await jsend('POST', `/api/images/${imgId}/revisions/nonexistent-id/restore`, { version: 10 });
    check('恢复不存在修订 404', r.status === 404, r.body);

    // 另一张切片：它有自己的基线修订；用它去访问 imgId 的修订必须 404
    const up2 = await upload(png);
    const img2 = up2.body.id;
    const tl2 = await revisionsOf(img2);
    check('第二张切片独立基线', tl2.count === 1 && tl2.revisions[0].imageId === img2);
    const img2Base = tl2.revisions[0].id;
    r = await jget(`/api/images/${img2}/revisions/${contoursRevId}`);
    check('跨切片访问修订 404', r.status === 404, r.body);
    r = await jsend('POST', `/api/images/${img2}/revisions/${contoursRevId}/restore`, { version: 1 });
    check('跨切片恢复 404', r.status === 404, r.body);
    // img2 的时间线不含 imgId 的修订
    check('跨切片修订不出现在时间线',
      (await revisionsOf(img2)).revisions.every((x) => x.id !== contoursRevId));
    // imgId 也访问不到 img2 的修订
    r = await jget(`/api/images/${imgId}/revisions/${img2Base}`);
    check('反向跨切片 404', r.status === 404, r.body);
    // 不存在的图片
    r = await jget('/api/images/no-such-image/revisions');
    check('图片不存在 404', r.status === 404, r.body);

    // 概览字段完整性
    const summary = (await revisionsOf(imgId)).revisions.find((x) => x.kind === 'contours');
    check('概览含计数与标尺',
      summary.cellCount === 1 && summary.calibrated === true &&
      Math.abs(summary.scaleUmPerPx - 1) < 1e-9, summary);

    // ---- 细胞迁移也留修订 ----
    // 在 img2 上准备：定标 scale=1 + 一个细胞并发布，作为来源报告
    await jsend('PUT', `/api/images/${img2}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    const img2V2 = (await jget(`/api/images/${img2}`)).body.version;
    await jsend('PUT', `/api/images/${img2}/contours`, {
      version: img2V2, cells: [{ id: 'src-1', name: '来源细胞', ...square(10, 10, 40) }]
    });
    const img2V3 = (await jget(`/api/images/${img2}`)).body.version;
    const pub2 = await jsend('POST', `/api/images/${img2}/publish`, { version: img2V3, title: '切片B 来源' });
    check('切片B 发布 201', pub2.status === 201, pub2.body && pub2.body.error);
    const srcReportId = pub2.body.report.id;
    const img2V4 = pub2.body.image.version;
    // 恢复 img2 到其基线（v1，未定标无细胞），再迁移：迁移后应按目标（未定标）测量为 null
    let rr = await jsend('POST', `/api/images/${img2}/revisions/${img2Base}/restore`,
      { version: img2V4 });
    check('img2 恢复基线 201', rr.status === 201, rr.body && rr.body.error);
    check('img2 恢复后无细胞未定标', rr.body.image.cells.length === 0 && rr.body.image.calib === null);
    const img2V5 = rr.body.image.version;
    // 迁移预览（恒等三点对应）
    const preview = await jsend('POST', `/api/images/${img2}/migrate/preview`, {
      reportId: srcReportId,
      sourcePoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }],
      targetPoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }]
    });
    check('迁移预览通过', preview.status === 200 && preview.body.ok === true, preview.body);
    // 确认迁移（携带预览时版本 v5）
    const mig = await jsend('POST', `/api/images/${img2}/migrate`, {
      version: img2V5, reportId: srcReportId,
      sourcePoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }],
      targetPoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }]
    });
    check('迁移确认 201', mig.status === 201, mig.body && mig.body.error);
    check('迁移追加 1 个细胞', mig.body.appendedCount === 1 && mig.body.image.cells.length === 1);
    check('迁移保留来源名称', mig.body.image.cells[0].name === '来源细胞');
    const migTl = await revisionsOf(img2);
    check('迁移产生 migrate 修订',
      migTl.revisions[0].kind === 'migrate' && migTl.revisions[0].cellCount === 1, migTl.revisions[0]);
    check('迁移修订与此前历史并存（不抹历史，共 5 条）',
      migTl.count === 5 &&
      ['migrate', 'restore', 'contours', 'calibration', 'baseline']
        .every((k) => migTl.revisions.some((x) => x.kind === k)),
      migTl.revisions.map((x) => x.kind));

  } finally {
    srv.kill();
    await new Promise((r) => setTimeout(r, 200));
  }

  // ---- 旧库启动补录基线：直接造一个只有 images 行、无修订的“旧库”，重启后应补录 ----
  {
    const dbFile = path.join(DATA_DIR, 'app.db');
    const Database = require('better-sqlite3');
    // 重启时 ensureBaselines 对已有修订的图片跳过；要模拟旧库，先删掉 image_revisions 内容
    const db0 = new Database(dbFile);
    db0.prepare('DELETE FROM image_revisions').run();
    const imgCount = db0.prepare('SELECT COUNT(*) AS n FROM images').get().n;
    check('旧库模拟：清空修订后图片仍在', imgCount >= 2);
    db0.close();

    const srv2 = startServer();
    let log = '';
    srv2.stdout.on('data', (d) => { log += String(d); });
    srv2.stderr.on('data', (d) => process.stderr.write(d));
    await waitReady(srv2);
    try {
      check('启动日志报告补录基线数', new RegExp(`已为 ${imgCount} 个既有草稿补录基线修订`).test(log), log.trim());
      // 每张图片恰好补一条 baseline，且版本为当前版本
      const db1 = new Database(dbFile, { readonly: true });
      const rows = db1.prepare(
        `SELECT ir.image_id, ir.version, ir.kind, i.version AS cur
         FROM image_revisions ir JOIN images i ON i.id = ir.image_id
         WHERE ir.kind = 'baseline'`).all();
      check('每张图片一条基线', rows.length === imgCount, rows);
      check('基线版本=当前版本', rows.every((x) => x.version === x.cur), rows);
      db1.close();

      // 再次重启：幂等，不重复补录
    } finally {
      srv2.kill();
      await new Promise((r) => setTimeout(r, 200));
    }

    const srv3 = startServer();
    let log3 = '';
    srv3.stdout.on('data', (d) => { log3 += String(d); });
    srv3.stderr.on('data', () => {});
    await waitReady(srv3);
    try {
      check('二次启动不重复补录', !/补录基线/.test(log3), log3.trim());
      const Database2 = require('better-sqlite3');
      const db2 = new Database2(dbFile, { readonly: true });
      const n = db2.prepare('SELECT COUNT(*) AS n FROM image_revisions').get().n;
      check('二次启动修订总数不变', n === imgCount, n);
      db2.close();
    } finally {
      srv3.kill();
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  if (failures) { console.error(`\n${failures} 项失败 ✖`); process.exit(1); }
  console.log('\n草稿修订时间线端到端自测全部通过 ✔');
}

main().catch((e) => { console.error(e); process.exit(1); });
