// Lists every purple frame of the mtgcardbuilder.com editor (they are only shown
// to logged-in accounts), with its pack, name, image, masks and bounds.
//
// Usage: log in on mtgcardbuilder.com on a computer, open the /creator/ page,
// press F12, open the "Console" tab, paste this whole file and press Enter
// (Chrome and Firefox first ask you to type "allow pasting"). It goes through
// every frame group and pack (about 10 minutes), then downloads
// purple-frames.json. Keep the tab in the foreground until then.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const abs = (s) => (typeof s === 'string' ? new URL(s, location.href).href : s);
  const isPurple = (f) => f && /purple/i.test((f.name || '') + ' ' + (f.src || ''));
  const found = {}, thumbs = {};
  let loaded = false;
  const orig = window.loadFramePack;
  window.loadFramePack = function () { loaded = true; return orig.apply(this, arguments); };
  const grab = (group, pack) => {
    (window.availableFrames || []).filter(isPurple).forEach((f) => {
      const e = JSON.parse(JSON.stringify(f));
      e.src = abs(e.src);
      (e.masks || []).forEach((m) => { m.src = abs(m.src); });
      found[pack + '|' + e.name + '|' + e.src] = Object.assign({ group: group, pack: pack }, e);
    });
    document.querySelectorAll('#frame-picker img').forEach((i) => { if (/purple/i.test(i.src)) thumbs[i.src] = pack; });
  };
  const pick = async (sel, value) => {
    loaded = false;
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 50 && !loaded; i++) await wait(100);
    await wait(1200);
  };
  const g = document.querySelector('#selectFrameGroup'), p = document.querySelector('#selectFramePack');
  const ok = (o) => !o.disabled && o.value && o.value !== 'disabled';
  for (const go of g ? [...g.options].filter(ok) : [{ value: '' }]) {
    if (g) await pick(g, go.value);
    for (const po of [...p.options].filter(ok)) {
      await pick(p, po.value);
      grab(go.value, po.value);
      console.log(go.value + ' / ' + po.value + ' : ' + Object.keys(found).length + ' purple frames so far');
    }
  }
  window.loadFramePack = orig;
  const data = { page: location.href, frames: Object.values(found), thumbs: thumbs };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  a.download = 'purple-frames.json';
  document.body.appendChild(a);
  a.click();
  console.log('Done: ' + data.frames.length + ' purple frames saved to purple-frames.json');
})();
