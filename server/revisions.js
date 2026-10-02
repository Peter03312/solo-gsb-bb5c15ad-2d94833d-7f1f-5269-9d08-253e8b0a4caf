'use strict';

// 草稿修订（draft revisions）
//
// 每次成功的【定标 / 细胞轮廓保存 / 取样视野保存 / 细胞迁移】都在同一事务内
// 留下一条与写入后草稿状态【完整一致】的修订快照（calib + cells + fields + 版本号）。
// 修订可预览（标尺、细胞轮廓、取样视野）并恢复为当前草稿；恢复本身也生成一条新修订，
// 且不抹掉之后的历史。已发布报告与更正链不受恢复影响。
//
// 已有草稿（本轮功能上线前的旧库、尚无修订）在启动时以当前状态补一条「基线」修订，
// 因此任何草稿都至少有一个可恢复基线；失败的写请求（400/409）不会调用写入，不留记录。

const crypto = require('crypto');

// 修订类型：基线（旧库启动补录 / 新上传）、四类写入、恢复
const KIND_LABELS = {
  baseline: '基线',
  calibration: '标尺定标',
  contours: '轮廓保存',
  fields: '视野保存',
  migrate: '细胞迁移',
  restore: '恢复修订'
};

function kindLabel(kind) {
  return KIND_LABELS[kind] || '修订';
}

function parseJson(raw, fallback) {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// 修订行 → 完整修订对象（含水合后的 calib/cells/fields 与按当时标尺现算的 fieldStats）。
// width/height 取自该切片（图片尺寸永不改变），fieldsSvc 由调用方注入以避免模块环依赖。
function hydrateRevision(row, imageWidth, imageHeight, fieldsSvc) {
  const calib = parseJson(row.calib, null);
  const cells = parseJson(row.cells, []);
  const fields = parseJson(row.fields, []);
  return {
    id: row.id,
    imageId: row.image_id,
    version: row.version,
    kind: row.kind,
    kindLabel: kindLabel(row.kind),
    restoredFromRevisionId: row.restored_from_revision_id || null,
    calib,
    cells,
    fields,
    fieldStats: fieldsSvc.buildFieldStats(fields, cells, calib ? calib.scale : null),
    width: imageWidth,
    height: imageHeight,
    createdAt: row.created_at
  };
}

// 修订列表项：概览信息（不含几何数据），按版本由新到旧排列。
function summarizeRevision(row) {
  const calib = parseJson(row.calib, null);
  const cells = parseJson(row.cells, []);
  const fields = parseJson(row.fields, []);
  const totalHoles = cells.reduce((s, c) => s + (Array.isArray(c.holes) ? c.holes.length : 0), 0);
  return {
    id: row.id,
    imageId: row.image_id,
    version: row.version,
    kind: row.kind,
    kindLabel: kindLabel(row.kind),
    restoredFromRevisionId: row.restored_from_revision_id || null,
    calibrated: !!calib,
    scaleUmPerPx: calib && typeof calib.scale === 'number' ? calib.scale : null,
    cellCount: cells.length,
    cellHoleCount: totalHoles,
    fieldCount: fields.length,
    createdAt: row.created_at
  };
}

// 在调用方事务内追加一条修订；snapshot 为写入后的草稿状态
// {id, version, calib, cells, fields}。cells/fields 必须是已按当前标尺重算好的完整数据。
function insertRevision(db, snapshot, kind, restoredFromRevisionId = null) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO image_revisions
              (id, image_id, version, kind, restored_from_revision_id, calib, cells, fields)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      snapshot.id,
      snapshot.version,
      kind,
      restoredFromRevisionId || null,
      JSON.stringify(snapshot.calib ?? null),
      JSON.stringify(Array.isArray(snapshot.cells) ? snapshot.cells : []),
      JSON.stringify(Array.isArray(snapshot.fields) ? snapshot.fields : [])
    );
  return id;
}

// 启动幂等补录：为尚没有任何修订的草稿以当前状态补一条基线修订（version 取当前版本号）。
// 已有修订的草稿不动，因此重复启动不会产生重复基线。返回补录条数。
function ensureBaselines(db, rows) {
  let created = 0;
  const findHas = db.prepare('SELECT 1 FROM image_revisions WHERE image_id = ? LIMIT 1');
  const insert = db.prepare(`INSERT INTO image_revisions
                             (id, image_id, version, kind, calib, cells, fields)
                             VALUES (?, ?, ?, 'baseline', ?, ?, ?)`);
  const tx = db.transaction((images) => {
    for (const row of images) {
      if (findHas.get(row.id)) continue;
      insert.run(
        crypto.randomUUID(),
        row.id,
        row.version,
        row.calib ?? null,
        row.cells || '[]',
        row.fields || '[]'
      );
      created += 1;
    }
  });
  tx(rows);
  return created;
}

module.exports = {
  KIND_LABELS,
  kindLabel,
  hydrateRevision,
  summarizeRevision,
  insertRevision,
  ensureBaselines
};
