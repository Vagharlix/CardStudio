// Card Studio interface layer on top of the card engine (creator-23.js).
(function () {
	'use strict';

	var $ = function (sel, root) { return (root || document).querySelector(sel); };
	var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
	function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
	function waitFor(test, timeout) {
		var start = Date.now();
		timeout = timeout || 8000;
		return new Promise(function (resolve, reject) {
			(function check() {
				var ok = false;
				try { ok = test(); } catch (e) { ok = false; }
				if (ok) return resolve(ok);
				if (Date.now() - start > timeout) return reject(new Error('timeout'));
				setTimeout(check, 40);
			})();
		});
	}
	function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
	function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
	function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

	/* ------------------------------------------------------------------
	 * Dialogs (prompt/confirm replacements that work in every webview)
	 * ------------------------------------------------------------------ */
	var dialogQueue = Promise.resolve();
	function dialog(opts) {
		var run = function () {
			return new Promise(function (resolve) {
				var box = $('#dialog');
				$('#dialog-title').textContent = opts.title || '';
				$('#dialog-text').textContent = opts.text || '';
				$('#dialog-text').classList.toggle('hidden', !opts.text);
				var fields = $('#dialog-fields');
				fields.innerHTML = '';
				(opts.fields || []).forEach(function (f) {
					var label = document.createElement('label');
					label.className = 'labeled';
					var span = document.createElement('span');
					span.textContent = f.label;
					label.appendChild(span);
					var input = document.createElement('input');
					input.className = 'input';
					input.type = f.type || 'text';
					input.value = f.value || '';
					input.dataset.field = f.id;
					if (f.placeholder) input.placeholder = f.placeholder;
					if (f.list && f.list.length) {
						var dl = document.createElement('datalist');
						dl.id = 'dl-' + f.id;
						f.list.forEach(function (v) { var o = document.createElement('option'); o.value = v; dl.appendChild(o); });
						label.appendChild(dl);
						input.setAttribute('list', dl.id);
					}
					label.appendChild(input);
					fields.appendChild(label);
				});
				var ok = $('#dialog-ok'), cancel = $('#dialog-cancel');
				ok.textContent = opts.ok || 'OK';
				cancel.textContent = opts.cancel || 'Cancel';
				cancel.classList.toggle('hidden', opts.cancel === false);
				var extra = $('#dialog-extra');
				if (extra) extra.remove();
				if (opts.extra) {
					extra = document.createElement('button');
					extra.type = 'button';
					extra.id = 'dialog-extra';
					extra.className = 'input';
					extra.textContent = opts.extra;
					cancel.after(extra);
				}
				function close(result) {
					box.classList.add('hidden');
					ok.onclick = cancel.onclick = null;
					if (extra) extra.onclick = null;
					document.removeEventListener('keydown', onKey, true);
					resolve(result);
				}
				function values() {
					var v = {};
					$$('input', fields).forEach(function (i) { v[i.dataset.field] = i.value; });
					return v;
				}
				function onKey(e) {
					if (e.key === 'Escape') { e.preventDefault(); close(null); }
					if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); close(values()); }
				}
				ok.onclick = function () { close(values()); };
				cancel.onclick = function () { close(null); };
				if (extra) extra.onclick = function () { close('extra'); };
				document.addEventListener('keydown', onKey, true);
				box.classList.remove('hidden');
				var first = $('input', fields);
				setTimeout(function () { (first || ok).focus(); if (first) first.select(); }, 30);
			});
		};
		var p = dialogQueue.then(run);
		dialogQueue = p.catch(function () {});
		return p;
	}
	window.dialog = dialog;
	window.dialogConfirm = function (title, text, okLabel) {
		return dialog({ title: title, text: text, ok: okLabel || 'OK' }).then(function (r) { return r !== null; });
	};
	window.askCardName = async function (defaultName) {
		var cats = await getCategories();
		var current = window.currentCardKey ? await CardStore.get(window.currentCardKey) : null;
		var r = await dialog({
			title: 'Save to gallery',
			fields: [
				{ id: 'name', label: 'Card name', value: (current && current.key) || defaultName || 'My card' },
				{ id: 'category', label: 'Category (optional)', value: (current && current.category) || '', list: cats, placeholder: 'ex: My set, Commander deck...' }
			],
			ok: 'Save'
		});
		if (!r || !r.name || !r.name.trim()) return null;
		return { name: r.name.trim(), category: (r.category || '').trim() };
	};
	// The engine uses confirm() for big uploads; keep it but never block the app.
	window.confirm = (function (nativeConfirm) {
		return function (msg) { try { return nativeConfirm.call(window, msg); } catch (e) { return true; } };
	})(window.confirm);

	/* ------------------------------------------------------------------
	 * Theme and views
	 * ------------------------------------------------------------------ */
	window.toggleTheme = function () {
		var next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
		document.documentElement.dataset.theme = next;
		lsSet('cs-theme', next);
	};
	window.showView = function (name) {
		['editor', 'gallery', 'print'].forEach(function (v) {
			$('#view-' + v).classList.toggle('hidden', v !== name);
		});
		$$('.topnav a').forEach(function (a) { a.classList.toggle('active', a.dataset.view === name); });
		document.body.dataset.view = name;
		if (name === 'gallery') renderGallery();
		if (name === 'print') renderPrintList();
		window.scrollTo(0, 0);
		if (history.replaceState) history.replaceState(null, '', '#' + name);
	};

	/* ------------------------------------------------------------------
	 * Rendering: coalesce redraws to one per animation frame
	 * ------------------------------------------------------------------ */
	var engineDrawCard = window.drawCard;
	var drawPending = false;
	var rotation = 0;
	window.drawCardNow = function () {
		drawPending = false;
		engineDrawCard();
		afterDraw();
	};
	window.drawCard = function () {
		if (drawPending) return;
		drawPending = true;
		var fire = function () { if (drawPending) drawCardNow(); };
		requestAnimationFrame(fire);
		setTimeout(fire, 120); // in case animation frames are throttled
	};
	// Faster text refresh than the engine's 500 ms debounce.
	window.drawTextBuffer = function () {
		clearTimeout(writingText);
		writingText = setTimeout(drawText, 90);
	};
	// Script loads are tracked so we know when a frame pack is ready.
	window.pendingScripts = 0;
	window.loadScript = function (scriptPath) {
		return new Promise(function (resolve) {
			var script = document.createElement('script');
			script.type = 'text/javascript';
			pendingScripts++;
			script.onload = function () { pendingScripts--; resolve(true); };
			script.onerror = function () { pendingScripts--; notify('A frame file failed to load: ' + scriptPath, 6); resolve(false); };
			script.src = scriptPath;
			document.head.appendChild(script);
		});
	};

	function afterDraw() {
		if (rotation) paintRotatedPreview();
		syncSliders();
		updateTextOutline();
		scheduleAutosave();
	}

	/* ------------------------------------------------------------------
	 * Rotate frame (view and export rotated by 90° steps)
	 * ------------------------------------------------------------------ */
	function setPreviewSize() {
		var landscape = rotation % 180 !== 0;
		var w = landscape ? 1407 : 1005, h = landscape ? 1005 : 1407;
		if (previewCanvas.width !== w || previewCanvas.height !== h) {
			previewCanvas.width = w;
			previewCanvas.height = h;
		}
		previewCanvas.style.aspectRatio = w + ' / ' + h;
	}
	function paintRotatedPreview() {
		var ctx = previewContext;
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
		ctx.translate(previewCanvas.width / 2, previewCanvas.height / 2);
		ctx.rotate(rotation * Math.PI / 180);
		var landscape = rotation % 180 !== 0;
		var dw = landscape ? previewCanvas.height : previewCanvas.width;
		var dh = landscape ? previewCanvas.width : previewCanvas.height;
		ctx.drawImage(cardCanvas, -dw / 2, -dh / 2, dw, dh);
		ctx.restore();
	}
	function applyRotation(r) {
		rotation = ((r || 0) % 360 + 360) % 360;
		card.csRotation = rotation;
		setPreviewSize();
		$('#rotateFrame').textContent = rotation ? 'Rotate Frame (' + rotation + '°)' : 'Rotate Frame';
		drawCard();
	}
	window.rotateFrame = function () { applyRotation(rotation + 90); };
	window.exportCanvas = function () {
		if (!rotation) return cardCanvas;
		var c = document.createElement('canvas');
		var landscape = rotation % 180 !== 0;
		c.width = landscape ? cardCanvas.height : cardCanvas.width;
		c.height = landscape ? cardCanvas.width : cardCanvas.height;
		var ctx = c.getContext('2d');
		ctx.translate(c.width / 2, c.height / 2);
		ctx.rotate(rotation * Math.PI / 180);
		ctx.drawImage(cardCanvas, -cardCanvas.width / 2, -cardCanvas.height / 2);
		return c;
	};

	/* ------------------------------------------------------------------
	 * Transparency highlight, branding, downloads
	 * ------------------------------------------------------------------ */
	window.toggleCardBackgroundColor = function (on) {
		previewCanvas.classList.toggle('show-transparency', !!on);
		lsSet('cs-transparency', on ? '1' : '0');
	};
	var engineLoadBottomInfo = window.loadBottomInfo;
	window.loadBottomInfo = function (textObjects) {
		Object.keys(textObjects || {}).forEach(function (k) {
			var t = textObjects[k];
			if (t && typeof t.text === 'string') t.text = t.text.replace(/CardConjurer\.com/gi, '');
		});
		return engineLoadBottomInfo(textObjects);
	};

	// Collector info: same as the engine, plus the "NOT FOR SALE" / copyright
	// lines (optional) and protection against overlapping redraws.
	var bottomGen = 0;
	window.bottomInfoEdited = async function () {
		var gen = ++bottomGen;
		bottomInfoContext.clearRect(0, 0, bottomInfoCanvas.width, bottomInfoCanvas.height);
		card.infoNumber = $('#info-number').value;
		card.infoRarity = $('#info-rarity').value;
		card.infoSet = $('#info-set').value;
		card.infoLanguage = $('#info-language').value;
		card.infoArtist = $('#info-artist').value;
		card.infoYear = $('#info-year').value;
		card.infoNote = $('#info-note').value;
		if ($('#enableCollectorInfo').checked) {
			var legal = $('#show-legal-lines').checked;
			var entries = Object.entries(card.bottomInfo || {});
			for (var i = 0; i < entries.length; i++) {
				if (gen !== bottomGen) return;
				var t = entries[i][1];
				if (!t || typeof t.text !== 'string') continue;
				if (/cardconjurer\.com/i.test(t.text)) continue;
				if (!legal && /NOT FOR SALE|Wizards of the Coast/.test(t.text)) continue;
				t.name = entries[i][0];
				await writeText(t, bottomInfoContext);
			}
		}
		if (gen === bottomGen) drawCard();
	};

	async function flushRender() {
		if (writingText) {
			clearTimeout(writingText);
			writingText = null;
			try { await drawText(); } catch (e) { /* keep going */ }
		}
		drawCardNow();
	}
	window.flushRender = flushRender;
	function canvasToBlob(canvas, type, quality) {
		return new Promise(function (resolve) { canvas.toBlob(resolve, type, quality); });
	}
	window.downloadCard = async function (alt, jpeg) {
		await flushRender();
		var artistMissing = (card.infoArtist || '').replace(/ /g, '') === '' && card.artSource && card.artSource.indexOf('/img/blank.png') === -1 && card.artZoom != 0;
		if (artistMissing) notify('Tip: credit the artist in the Art tab.', 4);
		var name = getCardName() || 'card';
		var blob = await canvasToBlob(exportCanvas(), jpeg ? 'image/jpeg' : 'image/png', jpeg ? 0.92 : undefined);
		await saveBlob(name + (jpeg ? '.jpg' : '.png'), blob);
	};
	window.renderCurrentCard = async function () {
		await flushRender();
		var full = exportCanvas();
		var image = await canvasToBlob(full, 'image/jpeg', 0.95);
		var t = document.createElement('canvas');
		t.width = 320;
		t.height = Math.round(320 * full.height / full.width);
		var tctx = t.getContext('2d');
		tctx.imageSmoothingQuality = 'high';
		tctx.drawImage(full, 0, 0, t.width, t.height);
		return { image: image, thumb: t.toDataURL('image/jpeg', 0.85) };
	};

	/* ------------------------------------------------------------------
	 * Dragging on the card: art, selected text, set symbol or watermark.
	 * One finger / mouse: move. Pinch, Shift + drag or Ctrl + wheel: resize.
	 * Ctrl + drag rotates the art.
	 * ------------------------------------------------------------------ */
	function cardPerScreenPixel() {
		var rect = previewCanvas.getBoundingClientRect();
		var shown = rotation % 180 === 0 ? rect.width : rect.height;
		return cardCanvas.width / shown;
	}
	function screenDeltaToCard(dx, dy) {
		var lx, ly;
		switch (rotation) {
			case 90: lx = dy; ly = -dx; break;
			case 180: lx = -dx; ly = -dy; break;
			case 270: lx = -dy; ly = dx; break;
			default: lx = dx; ly = dy;
		}
		var k = cardPerScreenPixel();
		lx *= k; ly *= k;
		if (card.landscape) { var t = lx; lx = -ly; ly = t; }
		return [lx, ly];
	}
	function screenPointToCard(px, py) {
		var rect = previewCanvas.getBoundingClientRect();
		var u = (px - rect.left) / rect.width, v = (py - rect.top) / rect.height, cu, cv;
		switch (rotation) {
			case 90: cu = v; cv = 1 - u; break;
			case 180: cu = 1 - u; cv = 1 - v; break;
			case 270: cu = 1 - v; cv = u; break;
			default: cu = u; cv = v;
		}
		return [cu * cardCanvas.width - card.marginX * card.width, cv * cardCanvas.height - card.marginY * card.height];
	}
	function num(id, fallback) { var v = parseFloat($('#' + id).value); return isFinite(v) ? v : fallback; }
	function setNum(id, v, digits) { var m = Math.pow(10, digits || 0); $('#' + id).value = Math.round(v * m) / m; }
	function selectedText() {
		var keys = Object.keys((card && card.text) || {});
		if (!keys.length) return null;
		return card.text[keys[Math.min(selectedTextIndex, keys.length - 1)]];
	}
	// Redraw the text right away (dragging), never more than one pass at a time.
	var textDrawBusy = false, textDrawAgain = false;
	function drawTextSoon() {
		if (textDrawBusy) { textDrawAgain = true; return; }
		textDrawBusy = true;
		clearTimeout(writingText);
		Promise.resolve().then(drawText).catch(function () {}).then(function () {
			textDrawBusy = false;
			if (textDrawAgain) { textDrawAgain = false; drawTextSoon(); }
		});
	}
	var dragTargets = {
		art: {
			hint: 'Drag the card to move the art. Pinch, or Shift + drag, to resize. Ctrl + drag rotates.',
			read: function () { return { x: num('art-x', 0), y: num('art-y', 0), zoom: num('art-zoom', 100), rotate: num('art-rotate', 0) }; },
			write: function (a) {
				setNum('art-x', a.x); setNum('art-y', a.y); setNum('art-zoom', Math.max(0.5, a.zoom), 1); setNum('art-rotate', a.rotate, 1);
				artEdited();
			},
			rotates: true
		},
		symbol: {
			hint: 'Drag the card to move the set symbol. Pinch, or Shift + drag, to resize.',
			read: function () { return { x: num('setSymbol-x', 0), y: num('setSymbol-y', 0), zoom: num('setSymbol-zoom', 100) }; },
			write: function (a) { setNum('setSymbol-x', a.x); setNum('setSymbol-y', a.y); setNum('setSymbol-zoom', Math.max(1, a.zoom), 1); setSymbolEdited(); }
		},
		watermark: {
			hint: 'Drag the card to move the watermark. Pinch, or Shift + drag, to resize.',
			read: function () { return { x: num('watermark-x', 0), y: num('watermark-y', 0), zoom: num('watermark-zoom', 100) }; },
			write: function (a) { setNum('watermark-x', a.x); setNum('watermark-y', a.y); setNum('watermark-zoom', Math.max(1, a.zoom), 1); watermarkEdited(); }
		},
		text: {
			hint: 'Tap a text on the card to select it, drag to move it. Pinch, or Shift + drag, to change its size.',
			read: function () {
				var t = selectedText();
				if (!t) return null;
				var base = (t.size || 0.038) * card.height;
				return { x: (t.x || 0) * card.width, y: (t.y || 0) * card.height, base: base, px: base + (parseFloat(t.fontSize) || 0) };
			},
			write: function (a) {
				var t = selectedText();
				if (!t) return;
				t.x = a.x / card.width;
				t.y = a.y / card.height;
				t.fontSize = Math.round(Math.max(4, a.px) - a.base);
				$('#text-editor-font-size').value = t.fontSize;
				fillTextBounds();
				drawTextSoon();
				updateTextOutline();
			}
		}
	};
	var dragTarget = 'art';
	window.setDragTarget = function (name) {
		if (!dragTargets[name]) return;
		dragTarget = name;
		$$('.drag-target button').forEach(function (b) { b.classList.toggle('active', b.dataset.target === name); });
		$('#drag-hint').textContent = dragTargets[name].hint;
		updateTextOutline();
	};
	function resizeTarget(target, start, factor, point) {
		if (target === dragTargets.text) {
			target.write({ x: start.x, y: start.y, base: start.base, px: start.px * factor });
			return;
		}
		var z = Math.max(0.5, start.zoom * factor), f = z / start.zoom;
		var next = Object.assign({}, start, { x: point[0] - (point[0] - start.x) * f, y: point[1] - (point[1] - start.y) * f, zoom: z });
		target.write(next);
	}
	function textBoxContains(t, pt) {
		var x = (t.x || 0) * card.width, y = (t.y || 0) * card.height;
		var w = (t.width || 1) * card.width, h = (t.height || 1) * card.height;
		return pt[0] >= x && pt[0] <= x + w && pt[1] >= y && pt[1] <= y + h ? w * h : 0;
	}
	// Text box under a card point, as an index into card.text: the selected one
	// if it is there, otherwise the smallest box containing the point.
	function textIndexAt(pt) {
		var keys = Object.keys(card.text || {});
		var current = selectedText();
		if (current && textBoxContains(current, pt)) return selectedTextIndex;
		var best = -1, bestArea = Infinity;
		keys.forEach(function (k, i) {
			var area = textBoxContains(card.text[k], pt);
			if (area && area < bestArea) { best = i; bestArea = area; }
		});
		return best;
	}
	function initCardGestures() {
		previewCanvas.onmousedown = previewCanvas.onmousemove = previewCanvas.onmouseout = previewCanvas.onmouseup = null;
		var pointers = new Map();
		var gesture = null;
		function begin() {
			var pts = Array.from(pointers.values());
			var target = dragTargets[dragTarget];
			var start = target.read();
			if (!start) { gesture = null; return; }
			gesture = { target: target, start: start, pts: pts.map(function (p) { return { x: p.x, y: p.y }; }) };
			if (pts.length >= 2) {
				gesture.dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
				gesture.mid = [(pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2];
			}
		}
		previewCanvas.addEventListener('pointerdown', function (e) {
			if (e.button !== undefined && e.button > 0) return;
			e.preventDefault();
			try { previewCanvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
			pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (dragTarget === 'text' && pointers.size === 1) {
				var idx = textIndexAt(screenPointToCard(e.clientX, e.clientY));
				var option = idx >= 0 && $('#text-options').children[idx];
				if (option && idx !== selectedTextIndex) option.click();
			}
			begin();
		});
		var frameQueued = false, lastMove = null;
		previewCanvas.addEventListener('pointermove', function (e) {
			if (!pointers.has(e.pointerId) || !gesture) return;
			pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			lastMove = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
			if (frameQueued) return;
			frameQueued = true;
			requestAnimationFrame(function () {
				frameQueued = false;
				if (!gesture) return;
				var target = gesture.target, start = gesture.start;
				var pts = Array.from(pointers.values());
				if (pts.length >= 2 && gesture.dist) {
					var dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
					var mid = [(pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2];
					var d = screenDeltaToCard(mid[0] - gesture.mid[0], mid[1] - gesture.mid[1]);
					var moved = Object.assign({}, start, { x: start.x + d[0], y: start.y + d[1] });
					resizeTarget(target, moved, dist / gesture.dist, screenPointToCard(mid[0], mid[1]));
				} else if (pts.length === 1) {
					var p = pts[0], s = gesture.pts[0];
					if (lastMove.shift) {
						resizeTarget(target, start, Math.pow(1.002, s.y - p.y), screenPointToCard(s.x, s.y));
					} else if (lastMove.ctrl && target.rotates) {
						target.write(Object.assign({}, start, { rotate: (start.rotate - (s.y - p.y) / 10) % 360 }));
					} else {
						var dd = screenDeltaToCard(p.x - s.x, p.y - s.y);
						target.write(Object.assign({}, start, { x: start.x + dd[0], y: start.y + dd[1] }));
					}
				}
			});
		});
		function end(e) {
			if (!pointers.has(e.pointerId)) return;
			pointers.delete(e.pointerId);
			if (pointers.size) begin(); else gesture = null;
		}
		previewCanvas.addEventListener('pointerup', end);
		previewCanvas.addEventListener('pointercancel', end);
		previewCanvas.addEventListener('wheel', function (e) {
			if (!e.ctrlKey && !e.altKey) return; // trackpad pinch sends ctrl+wheel
			e.preventDefault();
			var target = dragTargets[dragTarget], start = target.read();
			if (start) resizeTarget(target, start, Math.pow(0.998, e.deltaY), screenPointToCard(e.clientX, e.clientY));
		}, { passive: false });
	}

	/* ------------------------------------------------------------------
	 * Selected text: position / size fields and outline on the card
	 * ------------------------------------------------------------------ */
	window.fillTextBounds = function () {
		var t = selectedText();
		if (!t) return;
		if (!t.csOrig) t.csOrig = { x: t.x, y: t.y, width: t.width, height: t.height };
		setNum('tb-x', (t.x || 0) * card.width);
		setNum('tb-y', (t.y || 0) * card.height);
		setNum('tb-w', (t.width || 1) * card.width);
		setNum('tb-h', (t.height || 1) * card.height);
		$('#text-editor-font-size').value = parseFloat(t.fontSize) || 0;
		syncSliders();
	};
	window.textBoundsEdited = function () {
		var t = selectedText();
		if (!t) return;
		t.x = num('tb-x', 0) / card.width;
		t.y = num('tb-y', 0) / card.height;
		t.width = Math.max(1, num('tb-w', card.width)) / card.width;
		t.height = Math.max(1, num('tb-h', card.height)) / card.height;
		drawTextSoon();
		updateTextOutline();
	};
	window.resetTextBounds = function () {
		var t = selectedText();
		if (!t || !t.csOrig) return;
		t.x = t.csOrig.x; t.y = t.csOrig.y; t.width = t.csOrig.width; t.height = t.csOrig.height;
		t.fontSize = 0;
		fillTextBounds();
		drawTextSoon();
		updateTextOutline();
	};
	// Remember where each text box was placed by its frame, for "Reset position".
	var engineLoadTextOptions = window.loadTextOptions;
	window.loadTextOptions = function (textObject, replace) {
		Object.keys(textObject || {}).forEach(function (k) {
			var t = textObject[k];
			if (t && !t.csOrig) t.csOrig = { x: t.x, y: t.y, width: t.width, height: t.height };
		});
		var r = engineLoadTextOptions(textObject, replace);
		setTimeout(fillTextBounds, 0);
		return r;
	};
	function updateTextOutline() {
		var el = $('#text-outline');
		if (!el) return;
		var t = (dragTarget === 'text' && rotation === 0 && !card.landscape) ? selectedText() : null;
		if (!t || !previewCanvas.offsetWidth) { el.classList.add('hidden'); return; }
		var cw = cardCanvas.width, ch = cardCanvas.height;
		var x = ((t.x || 0) + card.marginX) * card.width / cw, y = ((t.y || 0) + card.marginY) * card.height / ch;
		var w = (t.width || 1) * card.width / cw, h = (t.height || 1) * card.height / ch;
		el.style.left = (previewCanvas.offsetLeft + x * previewCanvas.offsetWidth) + 'px';
		el.style.top = (previewCanvas.offsetTop + y * previewCanvas.offsetHeight) + 'px';
		el.style.width = (w * previewCanvas.offsetWidth) + 'px';
		el.style.height = (h * previewCanvas.offsetHeight) + 'px';
		el.classList.remove('hidden');
	}
	window.updateTextOutline = updateTextOutline;

	/* ------------------------------------------------------------------
	 * Sliders next to every position / size field
	 * ------------------------------------------------------------------ */
	var W = function () { return card.width || 2010; }, H = function () { return card.height || 2814; };
	var sliderDefs = {
		'art-x': function () { return [-W(), W(), 1]; },
		'art-y': function () { return [-H(), H(), 1]; },
		'art-zoom': function () { return [1, 500, 0.1]; },
		'art-rotate': function () { return [0, 360, 0.5]; },
		'setSymbol-x': function () { return [0, W(), 1]; },
		'setSymbol-y': function () { return [0, H(), 1]; },
		'setSymbol-zoom': function () { return [1, 400, 0.1]; },
		'watermark-x': function () { return [-W() / 2, W(), 1]; },
		'watermark-y': function () { return [-H() / 2, H(), 1]; },
		'watermark-zoom': function () { return [1, 400, 0.1]; },
		'watermark-opacity': function () { return [0, 100, 1]; },
		'serial-x': function () { return [0, W(), 1]; },
		'serial-y': function () { return [0, H(), 1]; },
		'serial-scale': function () { return [0.1, 3, 0.01]; },
		'tb-x': function () { return [-W() / 4, W(), 1]; },
		'tb-y': function () { return [-H() / 4, H(), 1]; },
		'tb-w': function () { return [10, W(), 1]; },
		'tb-h': function () { return [10, H(), 1]; },
		'text-editor-font-size': function () { return [-80, 80, 1]; },
		'frame-editor-x': function () { return [-W(), W(), 1]; },
		'frame-editor-y': function () { return [-H(), H(), 1]; },
		'frame-editor-width': function () { return [1, 2 * W(), 1]; },
		'frame-editor-height': function () { return [1, 2 * H(), 1]; },
		'frame-editor-opacity': function () { return [0, 100, 1]; },
		'textbox-editor-x': function () { return [-W() / 4, W(), 1]; },
		'textbox-editor-y': function () { return [-H() / 4, H(), 1]; },
		'textbox-editor-width': function () { return [10, W(), 1]; },
		'textbox-editor-height': function () { return [10, H(), 1]; }
	};
	var sliders = [];
	function syncSlider(p) {
		var d = p.def(), v = parseFloat(p.input.value), min = d[0], max = d[1];
		if (d[2] >= 1) { min = Math.floor(min); max = Math.ceil(max); } // whole-number steps from a whole-number start
		if (isFinite(v)) {
			if (v < min) min = Math.floor(v - Math.abs(v) * 0.25 - 1);
			if (v > max) max = Math.ceil(v * 1.25 + 1);
		}
		if (!p.active) {
			if (+p.range.min !== min) p.range.min = min;
			if (+p.range.max !== max) p.range.max = max;
			p.range.step = d[2];
			if (isFinite(v) && +p.range.value !== v) p.range.value = v;
		}
	}
	function syncSliders() {
		for (var i = 0; i < sliders.length; i++) {
			if (sliders[i].input.offsetParent !== null) syncSlider(sliders[i]);
		}
	}
	window.syncSliders = syncSliders;
	function attachSlider(id) {
		var input = document.getElementById(id);
		if (!input || input.dataset.slider) return;
		input.dataset.slider = '1';
		input.setAttribute('inputmode', 'decimal');
		var range = document.createElement('input');
		range.type = 'range';
		range.className = 'slider';
		range.setAttribute('aria-label', (input.closest('label, div') || input).textContent.trim() || id);
		input.insertAdjacentElement('afterend', range);
		input.parentElement.classList.add('has-slider');
		var p = { input: input, range: range, def: sliderDefs[id], active: false };
		range.addEventListener('pointerdown', function () { p.active = true; });
		['pointerup', 'pointercancel', 'change', 'blur'].forEach(function (ev) {
			range.addEventListener(ev, function () { p.active = false; syncSlider(p); });
		});
		range.addEventListener('input', function () {
			input.value = range.value;
			// fields use oninput (inline) or onchange (set by the engine)
			input.dispatchEvent(new Event(input.oninput ? 'input' : 'change', { bubbles: true }));
		});
		input.addEventListener('input', function () { syncSlider(p); });
		input.addEventListener('change', function () { syncSlider(p); });
		sliders.push(p);
		syncSlider(p);
	}
	function initSliders() {
		Object.keys(sliderDefs).forEach(attachSlider);
		// editors filled by the engine without events
		$('#frame-list').addEventListener('click', function () { setTimeout(syncSliders, 0); });
		$('#text-options').addEventListener('click', function () { setTimeout(fillTextBounds, 0); });
	}

	/* ------------------------------------------------------------------
	 * Custom frames of mtgcardbuilder.com (purple frames and a few extras),
	 * at the end of the pack like on the site: web/js/app/custom-frames.js,
	 * from scripts/import-site-custom-frames.mjs.
	 * ------------------------------------------------------------------ */
	var siteFrames = window.CS_CUSTOM_FRAMES || {};
	// Frame parts that are not a whole frame: the pack's masks make no sense on them.
	var NOT_WHOLE_FRAME = /\b(PT|Crown|Stamp|Symbol|Icon|Reminder|Title|Rules|Miracle)\b/;

	function addSiteFrames(list, frames) {
		var masks = null;
		list.some(function (f) { if (f && Array.isArray(f.masks) && f.masks.length) { masks = f.masks; return true; } return false; });
		frames.forEach(function (f) {
			var entry = { name: f.name, src: f.src, csExtra: true };
			if (masks && !NOT_WHOLE_FRAME.test(f.name)) entry.masks = masks;
			list.push(entry);
		});
	}
	// Pack scripts call loadFramePack() while they run: the running script
	// tells which pack this is.
	function currentPackId() {
		var script = document.currentScript;
		var m = script && /\/pack([^\/?#]+)\.js(?:[?#]|$)/.exec(script.src || '');
		if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
		var select = $('#selectFramePack');
		return select ? select.value : '';
	}
	var engineLoadFramePack = window.loadFramePack;
	window.loadFramePack = function (frameOptions) {
		var list = frameOptions || availableFrames;
		if (Array.isArray(list) && !list.some(function (f) { return f && f.csExtra; })) {
			var site = siteFrames[currentPackId()];
			if (site) addSiteFrames(list, site);
		}
		return engineLoadFramePack(list);
	};

	/* ------------------------------------------------------------------
	 * Text: quick symbol bar
	 * ------------------------------------------------------------------ */
	function initSymbolBar() {
		var bar = $('#symbol-bar');
		var symbols = ['w', 'u', 'b', 'r', 'g', 'purple', 'c', 'x', '1', '2', '3', '4', '5', 't', 'untap', 's', 'e'];
		symbols.forEach(function (s) {
			var b = document.createElement('button');
			b.type = 'button';
			b.title = '{' + s + '}';
			var img = document.createElement('img');
			img.alt = s;
			img.src = '/img/manaSymbols/' + s + '.svg';
			b.appendChild(img);
			b.onclick = function () { insertText('{' + s + '}'); };
			bar.appendChild(b);
		});
		[['{flavor}', 'Flavor'], ['{-}', '—'], ['{i}', 'i'], ['{/i}', '/i'], ['~', '~']].forEach(function (t) {
			var b = document.createElement('button');
			b.type = 'button';
			b.title = t[0];
			b.innerHTML = '<span class="txt">' + escapeHtml(t[1]) + '</span>';
			b.onclick = function () { insertText(t[0]); };
			bar.appendChild(b);
		});
	}
	function insertText(str) {
		var ta = $('#text-editor');
		var s = ta.selectionStart || 0, e = ta.selectionEnd || 0;
		ta.value = ta.value.slice(0, s) + str + ta.value.slice(e);
		ta.selectionStart = ta.selectionEnd = s + str.length;
		ta.focus();
		textEdited();
	}

	/* ------------------------------------------------------------------
	 * Watermark gallery
	 * ------------------------------------------------------------------ */
	var watermarks = [];
	function initWatermarks() {
		var group = 'General';
		var groups = [];
		$$('#watermark-lore option').forEach(function (o) {
			if (o.disabled) { group = o.textContent; groups.push(group); return; }
			watermarks.push({ name: o.textContent, src: o.value, group: group });
		});
		var cat = $('#watermark-category');
		cat.innerHTML = '<option value="">None</option>' + groups.map(function (g) { return '<option>' + escapeHtml(g) + '</option>'; }).join('') +
			'<option value="__sets">Set symbols (by set code)</option>';
		renderWatermarkGallery();
	}
	window.renderWatermarkGallery = function () {
		var q = ($('#watermark-search').value || '').trim().toLowerCase();
		var cat = $('#watermark-category').value;
		var list = [];
		if (cat !== '__sets') {
			list = watermarks.filter(function (w) {
				if (cat && w.group !== cat) return false;
				return !q || w.name.toLowerCase().indexOf(q) !== -1 || w.group.toLowerCase().indexOf(q) !== -1;
			});
		}
		var codes = (window.CS_DATA && CS_DATA.keyrune) || [];
		if (cat === '__sets' || (q && !cat)) {
			var sets = codes.filter(function (c) { return !q || c.indexOf(q) === 0; });
			if (cat !== '__sets') sets = sets.slice(0, 40);
			list = list.concat(sets.map(function (c) { return { name: c.toUpperCase(), src: '/img/keyrune/' + c + '.svg', group: 'Set symbols' }; }));
		}
		var grid = $('#watermark-gallery');
		grid.innerHTML = '';
		if (!list.length) {
			grid.innerHTML = '<p class="hint">No watermark found.</p>';
			return;
		}
		var frag = document.createDocumentFragment();
		list.forEach(function (w) {
			var b = document.createElement('button');
			b.type = 'button';
			b.className = 'watermark-item';
			b.title = w.group + ' — ' + w.name;
			var img = document.createElement('img');
			img.loading = 'lazy';
			img.alt = '';
			img.src = w.src;
			var span = document.createElement('span');
			span.textContent = w.name;
			b.appendChild(img);
			b.appendChild(span);
			b.onclick = function () {
				$$('.watermark-item.selected').forEach(function (x) { x.classList.remove('selected'); });
				b.classList.add('selected');
				getSetSymbolWatermark(w.src);
			};
			frag.appendChild(b);
		});
		grid.appendChild(frag);
	};

	/* ------------------------------------------------------------------
	 * Loading a card object into the editor (shared by gallery, presets,
	 * imports and autosave). Mirrors the engine's loadCard().
	 * ------------------------------------------------------------------ */
	window.loadCardFromObject = async function (obj) {
		if (!obj) return;
		$('#frame-list').innerHTML = null;
		card = JSON.parse(JSON.stringify(obj));
		card.text = card.text || {};
		card.frames = card.frames || [];
		card.manaSymbols = card.manaSymbols || [];
		$('#info-number').value = card.infoNumber || '';
		$('#info-rarity').value = card.infoRarity || '';
		$('#info-set').value = card.infoSet || '';
		$('#info-language').value = card.infoLanguage || '';
		$('#info-note').value = card.infoNote || '';
		$('#info-year').value = card.infoYear || new Date().getFullYear();
		artistEdited(card.infoArtist || '');
		var textKeys = Object.keys(card.text);
		if (textKeys.length) {
			if (selectedTextIndex >= textKeys.length) selectedTextIndex = 0;
			$('#text-editor').value = card.text[textKeys[selectedTextIndex]].text || '';
			$('#text-editor-font-size').value = card.text[textKeys[selectedTextIndex]].fontSize || 0;
			loadTextOptions(card.text);
		} else {
			$('#text-options').innerHTML = '';
			$('#text-editor').value = '';
		}
		$('#art-x').value = scaleX(card.artX) - scaleWidth(card.marginX);
		$('#art-y').value = scaleY(card.artY) - scaleHeight(card.marginY);
		$('#art-zoom').value = card.artZoom * 100;
		$('#art-rotate').value = card.artRotate || 0;
		uploadArt(card.artSource);
		$('#setSymbol-x').value = scaleX(card.setSymbolX) - scaleWidth(card.marginX);
		$('#setSymbol-y').value = scaleY(card.setSymbolY) - scaleHeight(card.marginY);
		$('#setSymbol-zoom').value = card.setSymbolZoom * 100;
		uploadSetSymbol(card.setSymbolSource);
		$('#watermark-x').value = scaleX(card.watermarkX) - scaleWidth(card.marginX);
		$('#watermark-y').value = scaleY(card.watermarkY) - scaleHeight(card.marginY);
		$('#watermark-zoom').value = card.watermarkZoom * 100;
		$('#watermark-opacity').value = card.watermarkOpacity * 100;
		$('#rounded-corners').checked = !card.noCorners;
		uploadWatermark(card.watermarkSource);
		$('#serial-number').value = card.serialNumber || '';
		$('#serial-total').value = card.serialTotal || '';
		$('#serial-x').value = card.serialX || 172;
		$('#serial-y').value = card.serialY || 1383;
		$('#serial-scale').value = card.serialScale || 1;
		serialInfoEdited();
		card.frames.reverse();
		card.frames.forEach(function (item) { addFrame([], item); });
		card.frames.reverse();
		if (card.onload) await loadScript(card.onload);
		card.manaSymbols.forEach(function (item) { loadScript(item); });
		var resized = false;
		canvasList.forEach(function (name) {
			var c = window[name + 'Canvas'];
			if (c.width != card.width * (1 + card.marginX) || c.height != card.height * (1 + card.marginY)) {
				sizeCanvas(name);
				resized = true;
			}
		});
		if (resized) {
			drawTextBuffer();
			drawFrames();
			bottomInfoEdited();
			watermarkEdited();
		}
		applyRotation(card.csRotation || 0);
	};

	/* ------------------------------------------------------------------
	 * Autosave of the card being edited
	 * ------------------------------------------------------------------ */
	var autosaveTimer = null, lastAutosave = '', autosaveReady = false;
	function scheduleAutosave() {
		if (!autosaveReady) return;
		clearTimeout(autosaveTimer);
		autosaveTimer = setTimeout(doAutosave, 1500);
	}
	function doAutosave() {
		var json;
		try { json = JSON.stringify(serializeCard()); } catch (e) { return; }
		if (json === lastAutosave) return;
		lastAutosave = json;
		CardStore.setState('autosave', { json: json, key: window.currentCardKey || null, time: Date.now() }).catch(function () {});
	}
	window.addEventListener('pagehide', function () { if (autosaveReady) doAutosave(); });
	document.addEventListener('visibilitychange', function () { if (document.hidden && autosaveReady) doAutosave(); });

	window.newCard = async function (action) {
		if (action !== 'cardback' && !(await dialogConfirm('Start a new card', 'The current card will be cleared (save it to your gallery first if you want to keep it).', 'New card'))) return;
		autosaveReady = false;
		clearTimeout(autosaveTimer);
		await CardStore.delState('autosave').catch(function () {});
		try { sessionStorage.setItem('cs-after-load', action || 'new'); } catch (e) { /* ignore */ }
		location.reload();
	};
	window.createCardBack = async function () {
		var r = await dialog({
			title: 'Create card back',
			text: 'Save the current card (the front) to your gallery before starting its back?',
			ok: 'Save, then create back', extra: 'Create back without saving', cancel: 'Cancel'
		});
		if (r === null) return;
		if (r !== 'extra') {
			var key = await saveToGallery();
			if (!key) return;
		}
		newCard('cardback');
	};
	async function applyCardBack() {
		var group = $('#selectFrameGroup');
		group.value = 'Misc-2';
		await loadScript('/js/frames/groupMisc-2.js');
		await waitFor(function () { return pendingScripts === 0; });
		var pack = $('#selectFramePack');
		pack.value = 'Cardback';
		await loadScript('/js/frames/packCardback.js');
		await waitFor(function () { return availableFrames[0] && availableFrames[0].name === 'Cardback' && $('#frame-picker .frame-option'); });
		if (card.version !== 'cardback') $('#loadFrameVersion').click();
		await waitFor(function () { return card.version === 'cardback'; }, 4000).catch(function () {});
		addFrame();
		notify('Card back ready: change the art, frame or text as you like.', 4);
	}

	/* ------------------------------------------------------------------
	 * Gallery, presets and print list
	 * ------------------------------------------------------------------ */
	async function getCategories() {
		var list = await CardStore.all();
		var set = {};
		list.forEach(function (e) { if (e.category) set[e.category] = 1; });
		return Object.keys(set).sort();
	}
	function fillCategorySelect(select, cats, label) {
		var v = select.value;
		select.innerHTML = '<option value="">' + label + '</option>' + cats.map(function (c) { return '<option>' + escapeHtml(c) + '</option>'; }).join('');
		if (cats.indexOf(v) !== -1) select.value = v;
	}
	window.saveToGallery = async function () {
		var answer = await askCardName(getCardName());
		if (!answer) return null;
		var data = serializeCard();
		var renders = await renderCurrentCard();
		await CardStore.put({ key: answer.name, data: data, category: answer.category, updated: Date.now(), image: renders.image, thumb: renders.thumb });
		window.currentCardKey = answer.name;
		await loadAvailableCards();
		notify('Gallery updated: "' + answer.name + '".', 3);
		return answer.name;
	};
	var galleryUrls = [];
	window.renderGallery = async function () {
		var list = await CardStore.all();
		fillCategorySelect($('#gallery-category'), await getCategories(), 'All categories');
		var q = ($('#gallery-search').value || '').trim().toLowerCase();
		var cat = $('#gallery-category').value;
		list = list.filter(function (e) {
			return (!cat || e.category === cat) && (!q || e.key.toLowerCase().indexOf(q) !== -1 || (e.category || '').toLowerCase().indexOf(q) !== -1);
		});
		var grid = $('#gallery-grid');
		grid.innerHTML = '';
		$('#gallery-empty').classList.toggle('hidden', list.length > 0);
		list.forEach(function (e) {
			var div = document.createElement('div');
			div.className = 'gallery-card';
			var img = document.createElement('img');
			img.alt = e.key;
			img.src = e.thumb || '/img/blank.png';
			img.onclick = function () { openFromGallery(e.key); };
			var h = document.createElement('h4');
			h.textContent = e.key;
			var meta = document.createElement('div');
			meta.className = 'meta';
			meta.textContent = (e.category ? e.category + ' · ' : '') + (e.updated ? new Date(e.updated).toLocaleDateString() : '') + (e.thumb ? '' : ' · open & save to render');
			var row = document.createElement('div');
			row.className = 'row';
			row.innerHTML = '<button class="input btn-red">Edit</button><button class="input btn-red">Image</button><button class="input btn-red">Delete</button>';
			var btns = row.querySelectorAll('button');
			btns[0].onclick = function () { openFromGallery(e.key); };
			btns[1].disabled = !e.image;
			btns[1].onclick = function () { saveBlob(e.key + '.jpg', e.image); };
			btns[2].onclick = async function () {
				if (!(await dialogConfirm('Delete card', 'Delete "' + e.key + '" from your gallery?', 'Delete'))) return;
				await CardStore.remove(e.key);
				if (window.currentCardKey === e.key) window.currentCardKey = null;
				loadAvailableCards();
				renderGallery();
			};
			div.appendChild(img);
			div.appendChild(h);
			div.appendChild(meta);
			div.appendChild(row);
			grid.appendChild(div);
		});
	};
	async function openFromGallery(key) {
		showView('editor');
		await loadCard(key);
	}
	window.refreshPresetList = async function () {
		var cats = await getCategories();
		var catSel = $('#preset-category');
		fillCategorySelect(catSel, cats, 'All categories');
		var list = await CardStore.all();
		var cat = catSel.value;
		var sel = $('#preset-card');
		sel.innerHTML = '<option value="" disabled selected>Choose a card...</option>';
		list.filter(function (e) { return !cat || e.category === cat; }).forEach(function (e) {
			var o = document.createElement('option');
			o.value = e.key;
			o.textContent = e.key + (e.category ? ' (' + e.category + ')' : '');
			sel.appendChild(o);
		});
	};
	window.loadPreset = async function (key) {
		var entry = await CardStore.get(key);
		if (!entry) return;
		window.currentCardKey = null; // saving creates a new card, the preset stays untouched
		await loadCardFromObject(entry.data);
		notify('Preset loaded: "' + key + '". Save it under a new name to keep the original.', 4);
	};
	document.addEventListener('cards-changed', function () { refreshPresetList(); });

	window.renderPrintList = async function () {
		var list = (await CardStore.all()).filter(function (e) { return e.image; });
		galleryUrls.forEach(URL.revokeObjectURL);
		galleryUrls = [];
		var box = $('#print-list');
		box.innerHTML = list.length ? '' : '<p class="hint">Save cards to your gallery first (the Print tool uses the images saved with them).</p>';
		list.forEach(function (e) {
			var div = document.createElement('div');
			div.className = 'print-item';
			var img = document.createElement('img');
			img.src = e.thumb || '';
			var label = document.createElement('label');
			label.innerHTML = '<span></span><input class="input" type="number" min="0" max="99" value="0">';
			label.querySelector('span').textContent = e.key;
			label.querySelector('input').dataset.key = e.key;
			div.appendChild(img);
			div.appendChild(label);
			box.appendChild(div);
		});
	};

	/* ------------------------------------------------------------------
	 * Phone layout: the card stays at the top while the settings scroll
	 * under it (CSS), with three preview sizes and a horizontal tab strip.
	 * ------------------------------------------------------------------ */
	var PREVIEW_SIZES = ['30vh', '20vh', '46vh'];
	var previewSize = Math.max(0, PREVIEW_SIZES.indexOf(lsGet('cs-preview-size')));
	function isPhoneLayout() { return window.matchMedia('(max-width: 999px)').matches; }
	function updateStickyOffsets() {
		var root = document.documentElement.style;
		root.setProperty('--topbar-h', $('.topbar').offsetHeight + 'px');
		root.setProperty('--card-col-h', $('#card-column').offsetHeight + 'px');
		updateTextOutline();
	}
	function applyPreviewSize() {
		document.documentElement.style.setProperty('--preview-h', PREVIEW_SIZES[previewSize]);
		requestAnimationFrame(updateStickyOffsets);
	}
	window.cyclePreviewSize = function () {
		previewSize = (previewSize + 1) % PREVIEW_SIZES.length;
		lsSet('cs-preview-size', PREVIEW_SIZES[previewSize]);
		applyPreviewSize();
	};
	var engineToggleCreatorTabs = window.toggleCreatorTabs;
	window.toggleCreatorTabs = function (event, target) {
		engineToggleCreatorTabs(event, target);
		var auto = { text: 'text', art: 'art', setSymbol: 'symbol', watermark: 'watermark' }[target];
		if (auto) setDragTarget(auto);
		if (target === 'text') fillTextBounds();
		syncSliders();
		if (!isPhoneLayout()) return;
		var tab = event && event.target && event.target.closest('h3');
		var strip = $('#creator-menu-tabs');
		if (tab && strip) strip.scrollTo({ left: tab.offsetLeft - (strip.clientWidth - tab.offsetWidth) / 2, behavior: 'smooth' });
		// bring the top of the tab content right under the sticky card + tabs
		var stickyBottom = strip.getBoundingClientRect().bottom;
		var top = $('#creator-menu-sections').getBoundingClientRect().top;
		if (Math.abs(top - stickyBottom) > 8) window.scrollTo({ top: window.scrollY + top - stickyBottom - 6, behavior: 'smooth' });
	};
	function initPhoneLayout() {
		applyPreviewSize();
		if ('ResizeObserver' in window) {
			var ro = new ResizeObserver(function () { updateStickyOffsets(); });
			ro.observe($('#card-column'));
			ro.observe($('.topbar'));
		}
		window.addEventListener('resize', updateStickyOffsets);
		document.body.dataset.view = 'editor';
	}

	/* ------------------------------------------------------------------
	 * Fonts: make sure card fonts are ready before drawing text
	 * ------------------------------------------------------------------ */
	function preloadCardFonts() {
		if (!document.fonts || !document.fonts.load) return Promise.resolve();
		var fams = ['belerenb', 'belerenbsc', 'mplantin', 'mplantini', 'gothammedium', 'gothambold', 'matrix', 'matrixb', 'plantinsemibold'];
		return Promise.all(fams.map(function (f) { return document.fonts.load('40px "' + f + '"').catch(function () {}); }));
	}

	/* ------------------------------------------------------------------
	 * Init
	 * ------------------------------------------------------------------ */
	async function init() {
		var after = null;
		try { after = sessionStorage.getItem('cs-after-load'); sessionStorage.removeItem('cs-after-load'); } catch (e) { /* ignore */ }

		toggleCardBackgroundColor($('#highlight-transparencies').checked = lsGet('cs-transparency') !== '0');
		$('#show-legal-lines').checked = lsGet('cs-legal-lines') !== '0';
		initCardGestures();
		initSymbolBar();
		initWatermarks();
		initSliders();
		initPhoneLayout();
		setDragTarget('art');
		var dl = $('#set-code-list');
		((window.CS_DATA && CS_DATA.setCodes) || []).forEach(function (c) { var o = document.createElement('option'); o.value = c; dl.appendChild(o); });
		$('#autoLoadFrameVersion').checked = lsGet('autoLoadFrameVersion') !== 'false';

		await migrateLocalStorageCards().catch(function () {});
		await loadAvailableCards();
		await preloadCardFonts();

		// wait for the default frame pack to be ready
		await waitFor(function () { return $('#frame-picker .frame-option') && card.text && pendingScripts === 0; }, 10000).catch(function () {});
		drawTextBuffer();
		bottomInfoEdited();

		if (after === 'cardback') {
			await applyCardBack().catch(function (e) { notify('Could not set up the card back: ' + e.message, 6); });
		} else if (after !== 'new') {
			var saved = await CardStore.getState('autosave').catch(function () { return null; });
			if (saved && saved.json) {
				try {
					window.currentCardKey = saved.key || null;
					lastAutosave = saved.json;
					await loadCardFromObject(JSON.parse(saved.json));
				} catch (e) { console.warn('autosave restore failed', e); }
			}
		}
		autosaveReady = true;
		var view = (location.hash || '').replace('#', '');
		if (view === 'gallery' || view === 'print') showView(view);
		document.documentElement.classList.add('ready');
		if (!window.isApp && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol) && location.hostname !== '127.0.0.1') {
			navigator.serviceWorker.register('/sw.js').catch(function () {});
		}
	}
	init();
})();
