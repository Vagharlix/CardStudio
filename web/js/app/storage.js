// Card storage.
// - In the app: every gallery card is a real file in a folder the user can
//   choose ("<name>.cardconjurer", plus "<name>.jpg" for its image), written
//   by the native side (src-tauri/src/library.rs). Cards survive restarts,
//   updates and reinstalls, and the folder can be copied to another device.
// - In a browser: IndexedDB (no 5 MB localStorage limit).
// Both keep the engine's ".cardconjurer" format, so files move between apps.
(function () {
	'use strict';
	var tauri = window.__TAURI__ && window.__TAURI__.core;

	/* ------------------------------------------------------------------
	 * IndexedDB (browser, and source of the one-time migration in the app)
	 * ------------------------------------------------------------------ */
	var DB_NAME = 'card-studio';
	var DB_VERSION = 1;
	var dbPromise = null;

	function openDb() {
		if (dbPromise) return dbPromise;
		dbPromise = new Promise(function (resolve, reject) {
			var req = indexedDB.open(DB_NAME, DB_VERSION);
			req.onupgradeneeded = function () {
				var db = req.result;
				if (!db.objectStoreNames.contains('cards')) db.createObjectStore('cards', { keyPath: 'key' });
				if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
			};
			req.onsuccess = function () { resolve(req.result); };
			req.onerror = function () { reject(req.error); };
		});
		return dbPromise;
	}
	function tx(store, mode, fn) {
		return openDb().then(function (db) {
			return new Promise(function (resolve, reject) {
				var t = db.transaction(store, mode);
				var s = t.objectStore(store);
				var result = fn(s);
				t.oncomplete = function () { resolve(result && 'result' in result ? result.result : result); };
				t.onerror = function () { reject(t.error); };
				t.onabort = function () { reject(t.error); };
			});
		});
	}
	function byKey(a, b) { return a.key.localeCompare(b.key, undefined, { numeric: true, sensitivity: 'base' }); }

	var IdbStore = {
		all: function () {
			return tx('cards', 'readonly', function (s) { return s.getAll(); }).then(function (list) {
				return (list || []).sort(byKey);
			});
		},
		get: function (key) { return tx('cards', 'readonly', function (s) { return s.get(key); }); },
		getImage: function (key) { return IdbStore.get(key).then(function (e) { return (e && e.image) || null; }); },
		put: function (entry) { return tx('cards', 'readwrite', function (s) { s.put(entry); }); },
		remove: function (key) { return tx('cards', 'readwrite', function (s) { s.delete(key); }); },
		clear: function () { return tx('cards', 'readwrite', function (s) { s.clear(); }); },
		keys: function () { return tx('cards', 'readonly', function (s) { return s.getAllKeys(); }); },
		getState: function (k) { return tx('state', 'readonly', function (s) { return s.get(k); }); },
		setState: function (k, v) { return tx('state', 'readwrite', function (s) { s.put(v, k); }); },
		delState: function (k) { return tx('state', 'readwrite', function (s) { s.delete(k); }); },
		location: function () { return Promise.resolve(null); }
	};

	/* ------------------------------------------------------------------
	 * Files (app)
	 * ------------------------------------------------------------------ */
	var CARD_EXT = '.cardconjurer';
	var lib = { location: null, cards: {}, index: {}, ready: null };

	function invoke(cmd, args) { return tauri.invoke(cmd, args || {}); }
	function isCardFile(name) { return name.toLowerCase().slice(-CARD_EXT.length) === CARD_EXT; }
	function baseOf(file) { return file.slice(0, -CARD_EXT.length); }
	function byteLength(text) { return new Blob([text]).size; }
	function base64ToBlob(b64, type) {
		var bin = atob(b64), bytes = new Uint8Array(bin.length);
		for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return new Blob([bytes], { type: type });
	}
	// File name for a card: its name, made safe for every file system, and
	// not already used by another card (case-insensitive, like Windows/Android).
	function fileBaseFor(key) {
		var base = String(key).replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 150) || 'card';
		var taken = {};
		Object.keys(lib.cards).forEach(function (k) { taken[baseOf(lib.cards[k].file).toLowerCase()] = true; });
		var name = base, n = 2;
		while (taken[name.toLowerCase()]) name = base + ' (' + n++ + ')';
		return name;
	}

	var indexTimer = null;
	function saveIndex() {
		clearTimeout(indexTimer);
		indexTimer = setTimeout(function () {
			var data = JSON.stringify({ token: lib.location && lib.location.token, files: lib.index });
			invoke('state_set', { key: 'library-index', value: data }).catch(function () {});
		}, 300);
	}

	// Reads the folder: the index of the last run (state "library-index")
	// avoids reading every card file again when nothing changed.
	async function loadLibrary() {
		lib.location = await invoke('library_info');
		var at = lib.location.token;
		var files = await invoke('library_list', { at: at });
		var cached = null;
		try { cached = JSON.parse(await invoke('state_get', { key: 'library-index' }) || 'null'); } catch (e) { cached = null; }
		var old = cached && cached.token === at ? (cached.files || {}) : {};
		var jpgs = {};
		files.forEach(function (f) { jpgs[f.name.toLowerCase()] = f.name; });
		var cards = {}, index = {};
		for (var i = 0; i < files.length; i++) {
			var f = files[i];
			if (!isCardFile(f.name)) continue;
			var meta = old[f.name];
			var same = meta && meta.size === f.size && (meta.modified == null || meta.modified === f.modified);
			if (!same) {
				var obj;
				try { obj = JSON.parse(await invoke('library_read', { at: at, name: f.name })); } catch (e) { continue; }
				if (Array.isArray(obj) && obj.length === 1) obj = obj[0];
				if (!obj || Array.isArray(obj) || !obj.data) continue; // not a single card (e.g. an "Export All" file)
				meta = { key: String(obj.key || baseOf(f.name)), category: obj.category || '', updated: obj.updated || f.modified, thumb: obj.thumb || null };
			}
			meta = Object.assign({}, meta, { file: f.name, size: f.size, modified: f.modified });
			meta.image = jpgs[(baseOf(f.name) + '.jpg').toLowerCase()] || null;
			if (cards[meta.key]) meta.key = uniqueKey(meta.key, Object.keys(cards));
			cards[meta.key] = meta;
			index[f.name] = meta;
		}
		lib.cards = cards;
		lib.index = index;
		saveIndex();
		await migrateIndexedDb();
		document.dispatchEvent(new CustomEvent('library-changed', { detail: lib.location }));
	}
	function ready() {
		if (!lib.ready) {
			lib.ready = loadLibrary().catch(function (e) {
				lib.ready = null;
				notify('Could not open the folder of your saved cards: ' + e, 10);
				throw e;
			});
		}
		return lib.ready;
	}

	async function writeCard(entry, at) {
		var meta = lib.cards[entry.key];
		var base = meta ? baseOf(meta.file) : fileBaseFor(entry.key);
		var file = base + CARD_EXT;
		var thumb = entry.thumb !== undefined ? entry.thumb : (meta && meta.thumb) || null;
		var body = { key: entry.key, category: entry.category || '', updated: entry.updated || Date.now(), thumb: thumb, data: entry.data };
		var text = JSON.stringify(body);
		await invoke('library_write', { at: at, name: file, text: text });
		var image = meta && meta.image;
		if (entry.image instanceof Blob) {
			image = base + '.jpg';
			await invoke('library_write', { at: at, name: image, base64: await blobToBase64(entry.image) });
		}
		var next = { key: entry.key, category: body.category, updated: body.updated, thumb: thumb, file: file, image: image || null, size: byteLength(text), modified: null };
		lib.cards[entry.key] = next;
		lib.index[file] = next;
		saveIndex();
	}
	async function deleteCard(key) {
		var meta = lib.cards[key];
		if (!meta) return;
		var at = lib.location.token;
		await invoke('library_delete', { at: at, name: meta.file });
		if (meta.image) await invoke('library_delete', { at: at, name: meta.image }).catch(function () {});
		delete lib.cards[key];
		delete lib.index[meta.file];
		saveIndex();
	}

	// Cards saved by earlier versions in IndexedDB move into the folder once.
	async function migrateIndexedDb() {
		if (await invoke('state_get', { key: 'idb-migrated' })) return;
		var list = [], autosave = null;
		try {
			list = await IdbStore.all();
			autosave = await IdbStore.getState('autosave');
		} catch (e) { /* no IndexedDB data */ }
		var moved = 0;
		for (var i = 0; i < list.length; i++) {
			var e = list[i];
			if (!e || !e.key || !e.data || lib.cards[e.key]) continue;
			await writeCard(e, lib.location.token);
			moved++;
		}
		if (autosave && !(await invoke('state_get', { key: 'autosave' }))) {
			await invoke('state_set', { key: 'autosave', value: JSON.stringify(autosave) });
		}
		await invoke('state_set', { key: 'idb-migrated', value: '1' });
		if (moved) notify(moved + ' saved card' + (moved === 1 ? '' : 's') + ' moved to ' + lib.location.label + '.', 6);
	}

	function light(meta) {
		return { key: meta.key, category: meta.category, updated: meta.updated, thumb: meta.thumb, hasImage: !!meta.image };
	}

	var FileStore = {
		all: async function () {
			await ready();
			return Object.keys(lib.cards).map(function (k) { return light(lib.cards[k]); }).sort(byKey);
		},
		get: async function (key) {
			await ready();
			var meta = lib.cards[key];
			if (!meta) return undefined;
			var obj = JSON.parse(await invoke('library_read', { at: lib.location.token, name: meta.file }));
			if (Array.isArray(obj)) obj = obj[0];
			return { key: meta.key, data: obj.data, category: meta.category, updated: meta.updated, thumb: meta.thumb, hasImage: !!meta.image };
		},
		getImage: async function (key) {
			await ready();
			var meta = lib.cards[key];
			if (!meta || !meta.image) return null;
			return base64ToBlob(await invoke('library_read', { at: lib.location.token, name: meta.image, base64: true }), 'image/jpeg');
		},
		put: async function (entry) {
			await ready();
			try {
				await writeCard(entry, lib.location.token);
			} catch (e) {
				notify('Could not save "' + entry.key + '": ' + e, 10);
				throw e;
			}
		},
		remove: async function (key) { await ready(); await deleteCard(key); },
		clear: async function () {
			await ready();
			var keys = Object.keys(lib.cards);
			for (var i = 0; i < keys.length; i++) await deleteCard(keys[i]);
		},
		keys: async function () { await ready(); return Object.keys(lib.cards); },
		getState: async function (k) {
			var v = await invoke('state_get', { key: k });
			return v == null ? undefined : JSON.parse(v);
		},
		setState: function (k, v) { return invoke('state_set', { key: k, value: JSON.stringify(v) }); },
		delState: function (k) { return invoke('state_set', { key: k, value: null }); },
		location: async function () { await ready(); return lib.location; },
		// Lets the user pick another folder. The cards of the current folder
		// are copied there (files already there are kept), then the gallery
		// shows the new folder: its own cards plus the copied ones.
		changeFolder: async function () {
			await ready();
			var picked = await invoke('library_pick');
			if (!picked) return null;
			var from = lib.location.token, to = picked.token;
			var copied = 0;
			if (to !== from) {
				var there = {};
				(await invoke('library_list', { at: to })).forEach(function (f) { there[f.name.toLowerCase()] = true; });
				var keys = Object.keys(lib.cards);
				for (var i = 0; i < keys.length; i++) {
					var meta = lib.cards[keys[i]];
					if (there[meta.file.toLowerCase()]) continue;
					var text = await invoke('library_read', { at: from, name: meta.file });
					await invoke('library_write', { at: to, name: meta.file, text: text });
					if (meta.image && !there[meta.image.toLowerCase()]) {
						var b64 = await invoke('library_read', { at: from, name: meta.image, base64: true });
						await invoke('library_write', { at: to, name: meta.image, base64: b64 });
					}
					copied++;
				}
			}
			await invoke('library_use', { token: to });
			lib.ready = null;
			await ready();
			return { location: lib.location, copied: copied, total: Object.keys(lib.cards).length };
		}
	};

	var Store = tauri ? FileStore : IdbStore;
	window.CardStore = Store;

	// Serializable copy of the current card (same as the engine's saveCard).
	window.serializeCard = function () {
		var copy = JSON.parse(JSON.stringify(card));
		(copy.frames || []).forEach(function (frame) {
			delete frame.image;
			(frame.masks || []).forEach(function (mask) { delete mask.image; });
		});
		return copy;
	};

	function uniqueKey(key, existing) {
		var base = key, n = 1;
		while (existing.indexOf(key) !== -1) { key = base + ' (' + n + ')'; n++; }
		return key;
	}
	window.uniqueCardKey = uniqueKey;

	// ---- engine overrides ----
	window.loadAvailableCards = function () {
		return Store.all().then(function (list) {
			var select = document.querySelector('#load-card-options');
			if (select) {
				select.innerHTML = '<option selected="selected" disabled>None selected</option>';
				list.forEach(function (entry) {
					var o = document.createElement('option');
					o.textContent = entry.key;
					o.value = entry.key;
					select.appendChild(o);
				});
			}
			document.dispatchEvent(new CustomEvent('cards-changed', { detail: list }));
			return list;
		});
	};

	// saveCard(): Import/Preset tab "Save Card" and file imports.
	window.saveCard = async function (saveFromFile) {
		var keys = await Store.keys();
		var cardKey, data, category = '';
		if (saveFromFile) {
			cardKey = String(saveFromFile.key || 'Imported card').trim();
			data = saveFromFile.data;
			cardKey = uniqueKey(cardKey, keys);
		} else {
			var answer = await askCardName(getCardName());
			if (!answer) return null;
			cardKey = answer.name;
			category = answer.category;
			if (keys.indexOf(cardKey) !== -1) {
				var overwrite = await dialogConfirm('Overwrite?', 'A card is already saved as "' + cardKey + '".\nOverwrite it? (Cancel adds a version number.)', 'Overwrite');
				if (!overwrite) cardKey = uniqueKey(cardKey, keys);
			}
			data = serializeCard();
		}
		var entry = { key: cardKey, data: data, category: category, updated: Date.now() };
		if (!saveFromFile) {
			var renders = await renderCurrentCard();
			entry.thumb = renders.thumb;
			entry.image = renders.image;
		} else {
			entry.category = saveFromFile.category || '';
		}
		await Store.put(entry);
		window.currentCardKey = saveFromFile ? window.currentCardKey : cardKey;
		await loadAvailableCards();
		if (!saveFromFile) notify('Saved "' + cardKey + '" to your gallery.', 3);
		return cardKey;
	};

	window.loadCard = async function (selectedCardKey) {
		var entry = await Store.get(selectedCardKey);
		if (!entry) { notify(selectedCardKey + ' failed to load.', 5); return; }
		window.currentCardKey = entry.key;
		await loadCardFromObject(entry.data);
	};

	window.deleteCard = async function () {
		var key = document.querySelector('#load-card-options').value;
		if (!key || key === 'None selected') return;
		if (!(await dialogConfirm('Delete card', 'Delete "' + key + '"?', 'Delete'))) return;
		await Store.remove(key);
		if (window.currentCardKey === key) window.currentCardKey = null;
		loadAvailableCards();
	};

	window.deleteSavedCards = async function () {
		var ok = await dialogConfirm('Delete ALL saved cards',
			'All of your saved cards will be deleted. Export them first if you want to keep them.\nThis cannot be undone.', 'Delete all');
		if (!ok) return;
		await Store.clear();
		window.currentCardKey = null;
		loadAvailableCards();
	};

	window.downloadSavedCards = async function () {
		var list = await Store.all();
		if (!list.length) { notify('No saved cards to export.', 3); return; }
		var out = [];
		for (var i = 0; i < list.length; i++) {
			var e = list[i].data ? list[i] : await Store.get(list[i].key);
			if (e) out.push({ key: e.key, data: e.data, category: e.category || undefined });
		}
		saveBlob('saved-cards.cardconjurer', new Blob([JSON.stringify(out)], { type: 'application/json' }));
	};

	// Accepts one or several files: "Export All" files, single cards, and
	// the card files of a Card Studio folder.
	window.uploadSavedCards = function (event) {
		var files = Array.prototype.slice.call((event.target && event.target.files) || []);
		if (!files.length) return;
		var count = 0;
		(async function () {
			for (var f = 0; f < files.length; f++) {
				var items;
				try { items = JSON.parse(await files[f].text()); } catch (e) { notify(files[f].name + ' is not a saved cards file.', 5); continue; }
				if (!Array.isArray(items)) items = [items];
				for (var i = 0; i < items.length; i++) {
					var it = items[i];
					if (!it || !it.data) continue;
					await saveCard({ key: it.key, data: it.data, category: it.category });
					count++;
				}
			}
			event.target.value = '';
			await loadAvailableCards();
			notify('Imported ' + count + ' card' + (count === 1 ? '' : 's') + '. Open them from the Gallery.', 4);
		})();
	};

	// One-time migration of cards saved by the engine in localStorage.
	window.migrateLocalStorageCards = async function () {
		var keys;
		try { keys = JSON.parse(localStorage.getItem('cardKeys') || '[]'); } catch (e) { keys = []; }
		if (!keys.length) return;
		for (var i = 0; i < keys.length; i++) {
			try {
				var data = JSON.parse(localStorage.getItem(keys[i]));
				if (data) await saveCard({ key: keys[i], data: data });
				localStorage.removeItem(keys[i]);
			} catch (e) { /* skip broken entry */ }
		}
		localStorage.setItem('cardKeys', '[]');
	};
})();
