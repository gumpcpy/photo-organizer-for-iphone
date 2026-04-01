import React, { useCallback, useEffect, useState } from 'react';

const steps = [
  {
    id: 'step1',
    title: '依副檔名分類',
    manual: false,
    desc: '將所選資料夾「根目錄」的檔案依類型移入：aae、heic_jpg、mov_mp4、png。其他副檔名會留在原地。',
  },
  {
    id: 'step2',
    title: '備份原始檔到 original_no_e',
    manual: false,
    desc: '在 heic_jpg 中偵測「編輯版」檔名並備份對應原始檔到 original_no_e。完成後自行加上灰色標籤，表示有多種檔案。支援結尾 _E（如 IMG_8431_E.HEIC）與 IMG_E 後接數字（如 IMG_E8431.HEIC ↔ IMG_8431.HEIC）。',
  },
  {
    id: 'manual3',
    title: '手動整理與標記要上傳的檔案',
    manual: true,
    desc: '在 heic_jpg、mov_mp4、png 與根目錄 original_no_e 中刪除不要的檔案；要上傳的檔案請自行在 Finder 標記綠色標籤區分。完成後按下方按鈕標記。',
  },
  {
    id: 'step4',
    title: '同步刪除關聯的 AAE / 原始檔',
    manual: false,
    desc: '請先把要丟棄的檔案移到「deleted」。程式會從每個檔名抽出數字鍵（如 IMG_8431 / IMG_E8431 → 8431），再在 aae 與 original_no_e 裡刪掉同一數字鍵的檔案（檔名不必完全相同）。',
  },
  {
    id: 'step5',
    title: '合併為 photo',
    manual: false,
    desc: '刪除整個 deleted 資料夾，並將 heic_jpg、mov_mp4、png、original_no_e 內檔案合併到 photo；若檔名衝突會自動加上編號。',
  },
  {
    id: 'manual6',
    title: '上傳到 Google 相簿',
    manual: true,
    desc: '將要上傳的檔案（例如依你在 Finder 的綠色標籤）上傳到 Google 相簿。完成後按下方按鈕標記。',
  },
];

function formatResult(stepId, data) {
  if (!data) return '';
  if (stepId === 'step1' && data.moved?.length)
    return data.moved.map((m) => `${m.from} → ${m.to}`).join('\n');
  if (stepId === 'step2') {
    if (data.moved?.length)
      return (
        '移入 original_no_e:\n' +
        data.moved.map((m) => (m.edited ? `${m.file} ← 編輯檔 ${m.edited} → ${m.to}` : `${m.to}`)).join('\n')
      );
    return '（沒有偵測到可成對的編輯檔／原始檔）';
  }
  if (stepId === 'step4') {
    const lines = [];
    if (data.keys?.length) lines.push(`數字鍵: ${data.keys.join(', ')}`);
    if (data.removed?.length) lines.push('已刪除:\n' + data.removed.join('\n'));
    else if (!data.note) lines.push('（aae / original_no_e 中沒有符合的檔案）');
    if (data.note) lines.push(data.note);
    if (data.skipped?.length) lines.push('無法抽出數字的檔名: ' + data.skipped.join(', '));
    return lines.join('\n\n') || '（沒有刪除任何檔案）';
  }
  if (stepId === 'step5' && data.moved?.length) return `已合併 ${data.moved.length} 個項目`;
  return JSON.stringify(data, null, 2);
}

export default function App() {
  const [root, setRoot] = useState(null);
  const [state, setState] = useState({});
  const [logs, setLogs] = useState({});
  const [busy, setBusy] = useState(null);

  const api = typeof window !== 'undefined' ? window.api : null;

  const refresh = useCallback(async (r) => {
    if (!r || !api) return;
    const s = await api.getState(r);
    setState(s || {});
  }, [api]);

  useEffect(() => {
    if (root) refresh(root);
  }, [root, refresh]);

  const pickFolder = async () => {
    if (!api) return;
    const p = await api.selectFolder();
    if (p) {
      setRoot(p);
      await refresh(p);
    }
  };

  const runStep = async (id) => {
    if (!root || !api) return;
    setBusy(id);
    setLogs((L) => ({ ...L, [id]: '' }));
    try {
      let data;
      if (id === 'step1') data = await api.step1(root);
      else if (id === 'step2') data = await api.step2(root);
      else if (id === 'step4') data = await api.step4(root);
      else if (id === 'step5') data = await api.step5(root);
      setLogs((L) => ({ ...L, [id]: formatResult(id, data) }));
    } catch (e) {
      setLogs((L) => ({ ...L, [id]: `錯誤: ${e.message || e}` }));
    } finally {
      setBusy(null);
    }
  };

  const markDone = async (key, value = true) => {
    if (!root || !api) return;
    const next = await api.saveState(root, { [key]: value });
    setState(next || {});
  };

  const ensureDeleted = async () => {
    if (!root || !api) return;
    setBusy('del');
    try {
      const p = await api.ensureDeletedFolder(root);
      setLogs((L) => ({ ...L, step4: `已建立或已存在:\n${p}` }));
    } catch (e) {
      setLogs((L) => ({ ...L, step4: String(e.message || e) }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="app-shell">
      <header className="header">
        <h1>照片整理助手</h1>
        <p>
          依序完成六個步驟，整理 iPhone 備份的 AAE、_E 編輯檔與原始檔。自動步驟執行後請在 Finder 檢查，再按「標記完成」；手動步驟完成後自行按鈕即可。
        </p>
      </header>

      <div className="folder-bar">
        <button type="button" className="btn btn-primary" onClick={pickFolder}>
          選擇月份資料夾
        </button>
        <div className="folder-path">{root || '尚未選擇資料夾…'}</div>
      </div>

      {!root && <p className="empty-hint">請先選擇要整理的資料夾。</p>}

      {root && (
        <div className="steps">
          {steps.map((s, i) => {
            const done = !!state[s.id];
            const active = !done;
            return (
              <section key={s.id} className={`step-card ${done ? 'done' : ''} ${active ? 'active' : ''}`}>
                <div className="step-num">{done ? '✓' : i + 1}</div>
                <div className="step-body">
                  <h2>{s.title}</h2>
                  <p className="desc">{s.desc}</p>
                  <div className="step-actions">
                    <span className={`badge ${s.manual ? '' : 'auto'}`}>{s.manual ? '手動' : '自動'}</span>
                    {!s.manual && s.id !== 'step4' && (
                      <button type="button" className="btn btn-primary" disabled={busy === s.id} onClick={() => runStep(s.id)}>
                        {busy === s.id ? '執行中…' : '執行此步驟'}
                      </button>
                    )}
                    {!s.manual && s.id === 'step4' && (
                      <>
                        <button type="button" className="btn btn-ghost" disabled={busy === 'del'} onClick={ensureDeleted}>
                          建立 deleted 資料夾
                        </button>
                        <button type="button" className="btn btn-primary" disabled={busy === 'step4'} onClick={() => runStep('step4')}>
                          {busy === 'step4' ? '執行中…' : '執行此步驟'}
                        </button>
                      </>
                    )}
                    <button type="button" className="btn btn-success" onClick={() => markDone(s.id, true)} disabled={done}>
                      {done ? '已完成' : '標記此步驟完成'}
                    </button>
                    {done && (
                      <button type="button" className="btn btn-ghost" onClick={() => markDone(s.id, false)}>
                        取消完成
                      </button>
                    )}
                  </div>
                  {logs[s.id] ? <pre className="log-box">{logs[s.id]}</pre> : null}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
