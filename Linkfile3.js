const imageInput = document.getElementById("imageInput");
const cardContainer = document.querySelector(".section");
const dropArea = document.getElementById("dropArea");
const popupPreview = document.querySelector(".PopUpPreview");
let files = [];
let currentPreviewIndex = -1; // Track current image index in preview mode

const INTERNAL_REORDER_MIME = "application/x-grid-reorder";
let activeDragItem = null;

const isInternalReorderDrag = (dataTransfer) => {
    if (activeDragItem) return true;
    if (!dataTransfer || !dataTransfer.types) return false;
    return Array.from(dataTransfer.types).includes(INTERNAL_REORDER_MIME);
};

const STORAGE_KEYS = Object.freeze({
    LEGACY_FILES: "images",
    MIGRATION_DONE: "images_migrated_to_indexeddb_v1"
});

const INDEXED_DB_CONFIG = Object.freeze({
    NAME: "upload_url_library",
    VERSION: 1,
    STORE: "appStore",
    FILES_ID: "images"
});

let storageStatusTimer = null;
let saveDebounceTimer = null;
let hiddenElementsObserver = null;
let renderAnimationFrameId = null;

const showStorageStatus = (message, type = "info", timeoutMs = 5000) => {
    const status = document.getElementById("storageStatus");
    if (!status) return;

    status.textContent = message;
    status.dataset.type = type;
    status.classList.add("visible");

    if (storageStatusTimer) {
        clearTimeout(storageStatusTimer);
    }

    storageStatusTimer = setTimeout(() => {
        status.classList.remove("visible");
    }, timeoutMs);
};

const readLegacyFilesFromLocalStorage = () => {
    try {
        const savedFiles = JSON.parse(localStorage.getItem(STORAGE_KEYS.LEGACY_FILES));
        return Array.isArray(savedFiles) ? savedFiles : [];
    } catch (error) {
        console.warn("Failed to parse legacy local storage data.", error);
        return [];
    }
};

const isQuotaExceededError = (error) => {
    if (!error) return false;
    const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
    return (
        error.name === "QuotaExceededError" ||
        error.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
        message.includes("quota")
    );
};

const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
    }

    return `${size.toFixed(size < 10 && unitIndex > 0 ? 1 : 0)} ${units[unitIndex]}`;
};

const estimateSerializedSize = (value) => {
    try {
        return new Blob([JSON.stringify(value)]).size;
    } catch (error) {
        console.warn("Unable to estimate payload size.", error);
        return 0;
    }
};

const storageAdapter = (() => {
    let dbPromise = null;

    const isIndexedDbAvailable = () => typeof window !== "undefined" && "indexedDB" in window;

    const openDatabase = () => {
        if (!isIndexedDbAvailable()) {
            return Promise.reject(new Error("IndexedDB is not supported in this browser."));
        }

        if (dbPromise) return dbPromise;

        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(INDEXED_DB_CONFIG.NAME, INDEXED_DB_CONFIG.VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(INDEXED_DB_CONFIG.STORE)) {
                    db.createObjectStore(INDEXED_DB_CONFIG.STORE, { keyPath: "id" });
                }
            };

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error("Failed to open IndexedDB."));
        });

        return dbPromise;
    };

    const readFilesRecord = (db) => {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(INDEXED_DB_CONFIG.STORE, "readonly");
            const store = transaction.objectStore(INDEXED_DB_CONFIG.STORE);
            const request = store.get(INDEXED_DB_CONFIG.FILES_ID);

            request.onsuccess = () => {
                const record = request.result;
                resolve(record && Array.isArray(record.value) ? record.value : null);
            };
            request.onerror = () => reject(request.error || new Error("Failed to read from IndexedDB."));
        });
    };

    const writeFilesRecord = (db, nextFiles) => {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(INDEXED_DB_CONFIG.STORE, "readwrite");
            const store = transaction.objectStore(INDEXED_DB_CONFIG.STORE);

            store.put({
                id: INDEXED_DB_CONFIG.FILES_ID,
                value: nextFiles,
                updatedAt: Date.now()
            });

            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error || new Error("Failed to write to IndexedDB."));
            transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted."));
        });
    };

    const clearFilesRecord = (db) => {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(INDEXED_DB_CONFIG.STORE, "readwrite");
            const store = transaction.objectStore(INDEXED_DB_CONFIG.STORE);
            const request = store.delete(INDEXED_DB_CONFIG.FILES_ID);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error || new Error("Failed to clear IndexedDB data."));
        });
    };

    const migrateLegacyData = async (db) => {
        const migrationDone = localStorage.getItem(STORAGE_KEYS.MIGRATION_DONE) === "1";
        if (migrationDone) return;

        const storedInIndexedDb = await readFilesRecord(db);
        if (Array.isArray(storedInIndexedDb) && storedInIndexedDb.length > 0) {
            localStorage.setItem(STORAGE_KEYS.MIGRATION_DONE, "1");
            return;
        }

        const legacyFiles = readLegacyFilesFromLocalStorage();
        if (legacyFiles.length > 0) {
            await writeFilesRecord(db, legacyFiles);
            localStorage.removeItem(STORAGE_KEYS.LEGACY_FILES);
            showStorageStatus("Existing files were moved to larger browser storage.", "success", 6500);
        }

        localStorage.setItem(STORAGE_KEYS.MIGRATION_DONE, "1");
    };

    const loadFiles = async () => {
        if (!isIndexedDbAvailable()) {
            return readLegacyFilesFromLocalStorage();
        }

        try {
            const db = await openDatabase();
            await migrateLegacyData(db);
            const indexedDbFiles = await readFilesRecord(db);
            if (Array.isArray(indexedDbFiles)) {
                return indexedDbFiles;
            }
        } catch (error) {
            console.warn("IndexedDB load failed. Falling back to localStorage.", error);
        }

        return readLegacyFilesFromLocalStorage();
    };

    const saveFiles = async (nextFiles) => {
        if (!Array.isArray(nextFiles)) {
            throw new Error("Expected an array of files.");
        }

        if (isIndexedDbAvailable()) {
            try {
                const db = await openDatabase();
                await writeFilesRecord(db, nextFiles);
                localStorage.setItem(STORAGE_KEYS.MIGRATION_DONE, "1");
                return;
            } catch (error) {
                console.warn("IndexedDB save failed. Trying localStorage fallback.", error);
            }
        }

        localStorage.setItem(STORAGE_KEYS.LEGACY_FILES, JSON.stringify(nextFiles));
    };

    const clearFiles = async () => {
        if (isIndexedDbAvailable()) {
            try {
                const db = await openDatabase();
                await clearFilesRecord(db);
            } catch (error) {
                console.warn("Failed to clear IndexedDB data.", error);
            }
        }

        localStorage.removeItem(STORAGE_KEYS.LEGACY_FILES);
        localStorage.removeItem(STORAGE_KEYS.MIGRATION_DONE);
    };

    const getUsageEstimate = async () => {
        if (!navigator.storage || typeof navigator.storage.estimate !== "function") {
            return null;
        }

        try {
            return await navigator.storage.estimate();
        } catch (error) {
            console.warn("Storage estimate is not available.", error);
            return null;
        }
    };

    return {
        loadFiles,
        saveFiles,
        clearFiles,
        getUsageEstimate
    };
})();

let saveQueue = Promise.resolve();

const enqueueStorageSave = (snapshot) => {
    saveQueue = saveQueue
        .catch(() => undefined)
        .then(() => storageAdapter.saveFiles(snapshot));

    return saveQueue;
};

const persistFiles = async (nextFiles = files, options = {}) => {
    const { silent = false } = options;

    try {
        await enqueueStorageSave(nextFiles);
    } catch (error) {
        if (!silent) {
            if (isQuotaExceededError(error)) {
                showStorageStatus("Browser storage is full. Export JSON to save a backup on Windows.", "warning", 9000);
            } else {
                showStorageStatus("Could not save to browser storage right now.", "error", 7000);
            }
        }
        throw error;
    }
};

const schedulePersistFiles = (options = {}) => {
    const { delayMs = 450, silent = true } = options;

    if (saveDebounceTimer) {
        clearTimeout(saveDebounceTimer);
    }

    saveDebounceTimer = setTimeout(() => {
        saveDebounceTimer = null;
        void persistFiles(files, { silent }).catch(() => undefined);
    }, delayMs);
};

const flushScheduledPersistence = async (options = {}) => {
    const { silent = true } = options;

    if (saveDebounceTimer) {
        clearTimeout(saveDebounceTimer);
        saveDebounceTimer = null;
    }

    await persistFiles(files, { silent });
};

const normalizeImportedItem = (item) => {
    if (typeof item === "string") {
        const value = item.trim();
        return value ? value : null;
    }

    if (!item || typeof item !== "object") {
        return null;
    }

    if (item.type === "gif" && typeof item.src === "string") {
        const src = item.src.trim();
        return src ? { type: "gif", src } : null;
    }

    if (item.type === "youtube" && typeof item.url === "string" && typeof item.thumbnail === "string") {
        const url = item.url.trim();
        const thumbnail = item.thumbnail.trim();
        return url && thumbnail ? { type: "youtube", url, thumbnail } : null;
    }

    if (item.type === "codepen" && typeof item.url === "string" && typeof item.thumbnail === "string") {
        const url = item.url.trim();
        const thumbnail = item.thumbnail.trim();
        return url && thumbnail ? { type: "codepen", url, thumbnail } : null;
    }

    if (item.type === "link" && typeof item.url === "string") {
        const url = item.url.trim();
        return url ? { type: "link", url } : null;
    }

    return null;
};

const sanitizeImportedItems = (items) => {
    const accepted = [];
    let rejected = 0;

    items.forEach((item) => {
        const normalized = normalizeImportedItem(item);
        if (normalized) {
            accepted.push(normalized);
        } else {
            rejected += 1;
        }
    });

    return { accepted, rejected };
};

const GIF_MODES = Object.freeze({
    PLAYBACK: "playback",
    SCROLL: "scroll"
});

// Update the stored state of GIF mode instead of forcing a constant.
let activeGifMode = GIF_MODES.PLAYBACK;

const isScrollModeActive = () => activeGifMode === GIF_MODES.SCROLL;

const patchGifPlayerModeGuards = () => {
    const GifPlayerElement = customElements.get("gif-player");
    if (!GifPlayerElement) return;

    const proto = GifPlayerElement.prototype;
    if (proto.__modeGuardsPatched) return;

    const originalMove = proto.move;
    const originalPausePlayback = proto.pausePlayback;
    const originalResumePlayback = proto.resumePlayback;

    proto.move = function(event) {
        if (!this._swipe) return;
        return originalMove.call(this, event);
    };

    proto.pausePlayback = function(event) {
        if (!this._swipe && event) return;
        return originalPausePlayback.call(this, event);
    };

    proto.resumePlayback = function(event) {
        if (!this._swipe && event) return;
        return originalResumePlayback.call(this, event);
    };

    proto.__modeGuardsPatched = true;
};

const applyGifInteractionMode = (container = document) => {
    patchGifPlayerModeGuards();

    container.querySelectorAll("gif-player").forEach((player) => {
        player.swipe = isScrollModeActive();
        player.style.cursor = isScrollModeActive() ? "col-resize" : "default";
        player.setAttribute("data-gif-mode", activeGifMode);
    });
};

const normalizeGridGifCanvas = (player) => {
    if (!player || !player.shadowRoot) return;
    const canvas = player.shadowRoot.querySelector("canvas");
    if (!canvas) return;

    canvas.style.transform = "none";
    if (!canvas.style.top) {
        canvas.style.top = "0px";
    }
    if (!canvas.style.left) {
        canvas.style.left = "0px";
    }
};

const setupGridGifSizing = (container) => {
    container.querySelectorAll(".holder gif-player").forEach((player) => {
        const applySizing = () => {
            requestAnimationFrame(() => normalizeGridGifCanvas(player));
        };

        player.addEventListener("gif-loaded", applySizing, { once: true });

        if (player._gif) {
            applySizing();
        }
    });
};

patchGifPlayerModeGuards();

if (window.customElements && typeof window.customElements.whenDefined === "function") {
    window.customElements.whenDefined("gif-player").then(() => {
        patchGifPlayerModeGuards();
        applyGifInteractionMode(document);
    });
}

const initializePersistedFiles = async () => {
    files = await storageAdapter.loadFiles();
    const upgraded = upgradeCodepenEntries(files);
    files = upgraded.items;
    showImages();

    if (upgraded.didChange) {
        await persistFiles(files, { silent: true });
    }

    const usageEstimate = await storageAdapter.getUsageEstimate();
    if (!usageEstimate || !usageEstimate.quota || !usageEstimate.usage) return;

    const usageRatio = usageEstimate.quota > 0 ? usageEstimate.usage / usageEstimate.quota : 0;
    if (usageRatio >= 0.85) {
        showStorageStatus(
            `Storage usage is high (${Math.round(usageRatio * 100)}%). Export JSON to keep a Windows backup.`,
            "warning",
            9000
        );
    }
};

window.addEventListener("load", () => {
    void initializePersistedFiles();
});

const setupGifModeToggle = () => {
    const toggle = document.getElementById("gifModeToggle");
    if (!toggle) return;
    
    // Set initial UI checked state based on current mode
    toggle.checked = activeGifMode === GIF_MODES.SCROLL;
    
    toggle.addEventListener("change", (e) => {
        activeGifMode = e.target.checked ? GIF_MODES.SCROLL : GIF_MODES.PLAYBACK;
        // Re-apply correct modes across existing elements on the screen
        applyGifInteractionMode(document);
        
        // If preview is currently open, refresh to show/hide controls instead of closing
        const previewContainer = document.querySelector(".PopUpPreview");
        if (previewContainer && previewContainer.style.display === "block" && currentPreviewIndex >= 0) {
            showPreview(currentPreviewIndex);
        } else {
            closePreview();
        }
    });
};

setupGifModeToggle();

const readFileAsLibraryEntry = (file) => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = (event) => {
            const fileUrl = event.target.result;
            const isGif = typeof file.type === "string" && file.type.toLowerCase().includes("gif");
            resolve(isGif ? { src: fileUrl, type: "gif" } : fileUrl);
        };

        reader.onerror = () => reject(reader.error || new Error("Could not read file."));
        reader.readAsDataURL(file);
    });
};

const appendEntriesAndPersist = (entries) => {
    if (!Array.isArray(entries) || entries.length === 0) return;
    files.push(...entries);
    showImages();
    saveToLocalStorage();
};

// Handle paste event
const handlePasteEvent = async (e) => {
    const items = e.clipboardData ? Array.from(e.clipboardData.items || []) : [];
    const pastedFiles = items
        .filter((item) => item.type && item.type.indexOf("image") !== -1)
        .map((item) => item.getAsFile())
        .filter(Boolean);

    if (pastedFiles.length === 0) return;

    const results = await Promise.allSettled(pastedFiles.map((file) => readFileAsLibraryEntry(file)));
    const accepted = [];
    let failed = 0;

    results.forEach((result) => {
        if (result.status === "fulfilled") {
            accepted.push(result.value);
        } else {
            failed += 1;
        }
    });

    appendEntriesAndPersist(accepted);

    if (failed > 0) {
        showStorageStatus(`Added ${accepted.length} item(s). ${failed} item(s) failed to load.`, "warning", 7000);
    }
};

window.addEventListener("paste", handlePasteEvent, true);

const handleDragOver = (e) => {
    if (isInternalReorderDrag(e.dataTransfer)) return;

    if (e.__dragHandled) return;
    e.__dragHandled = true;
    e.preventDefault();
    if (e.dataTransfer) {
        e.dataTransfer.dropEffect = "copy";
    }
    dropArea.classList.add("dragover");
};

const handleDragLeave = () => {
    dropArea.classList.remove("dragover");
};

const extractFirstUrl = (text) => {
    if (typeof text !== "string") return "";
    const match = text.match(/https?:\/\/[^\s<>"')]+/i);
    return match ? match[0] : "";
};

const getDroppedUrl = (dataTransfer) => {
    if (!dataTransfer) return "";

    const uriList = dataTransfer.getData("text/uri-list");
    if (uriList) {
        const parsed = uriList
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line && !line.startsWith("#"));
        if (parsed) return parsed;
    }

    const plainText = dataTransfer.getData("text/plain");
    if (!plainText) return "";

    const extracted = extractFirstUrl(plainText);
    return extracted ? extracted.trim() : plainText.trim();
};

const handleWindowDragLeave = (e) => {
    const exitedViewport =
        e.clientX <= 0 ||
        e.clientY <= 0 ||
        e.clientX >= window.innerWidth ||
        e.clientY >= window.innerHeight;

    if (exitedViewport) {
        handleDragLeave();
    }
};

const handleDrop = async (e) => {
    if (isInternalReorderDrag(e.dataTransfer)) {
        e.preventDefault();
        e.stopPropagation();
        dropArea.classList.remove("dragover");
        return;
    }

    if (e.__dropHandled) return;
    e.__dropHandled = true;

    e.preventDefault();
    e.stopPropagation();
    dropArea.classList.remove("dragover");

    if (!e.dataTransfer) return;

    // Check if the dropped item is a file or a URL
    if (e.dataTransfer.files.length > 0) {
        const droppedFiles = e.dataTransfer.files;
        await handleDroppedFiles(droppedFiles);
    } else {
        const droppedUrl = getDroppedUrl(e.dataTransfer);
        if (!droppedUrl) return;

        // Check if the URL points to an image or YouTube video or is a generic link
        if (isImageUrl(droppedUrl)) {
            handleDroppedUrl(droppedUrl);
        } else if (isYouTubeUrl(droppedUrl)) {
            handleYouTubeUrl(droppedUrl);
        } else if (isCodepenUrl(droppedUrl)) {
            handleCodepenUrl(droppedUrl);
        } else {
            handleGenericLink(droppedUrl);
        }
    }
};

// Drag and drop event listeners
dropArea.addEventListener("dragover", handleDragOver);
dropArea.addEventListener("dragleave", handleDragLeave);
dropArea.addEventListener("drop", handleDrop);

if (popupPreview) {
    popupPreview.addEventListener("dragover", handleDragOver);
    popupPreview.addEventListener("dragleave", handleDragLeave);
    popupPreview.addEventListener("drop", handleDrop);
}

document.addEventListener("dragover", handleDragOver);
document.addEventListener("drop", handleDrop);
document.addEventListener("dragend", handleDragLeave);
window.addEventListener("dragleave", handleWindowDragLeave);

imageInput.addEventListener("change", () => {
    const selectedFiles = imageInput.files;
    void handleDroppedFiles(selectedFiles);
});

const handleDroppedFiles = async (fileList) => {
    const selectedFiles = Array.from(fileList || []);
    if (selectedFiles.length === 0) return;

    const results = await Promise.allSettled(selectedFiles.map((file) => readFileAsLibraryEntry(file)));
    const accepted = [];
    let failed = 0;

    results.forEach((result) => {
        if (result.status === "fulfilled") {
            accepted.push(result.value);
        } else {
            failed += 1;
        }
    });

    appendEntriesAndPersist(accepted);

    if (failed > 0) {
        showStorageStatus(`Added ${accepted.length} item(s). ${failed} file(s) failed to read.`, "warning", 7000);
    }
};

const handleDroppedUrl = (url) => {
    const normalizedUrl = url.trim();
    if (!normalizedUrl) return;

    if (isYouTubeUrl(normalizedUrl)) {
        handleYouTubeUrl(normalizedUrl);
        return;
    }

    if (isCodepenUrl(normalizedUrl)) {
        handleCodepenUrl(normalizedUrl);
        return;
    }

    if (isImageUrl(normalizedUrl)) {
        const entry = normalizedUrl.toLowerCase().endsWith(".gif")
            ? { src: normalizedUrl, type: "gif" }
            : normalizedUrl;
        appendEntriesAndPersist([entry]);
        return;
    }

    handleGenericLink(normalizedUrl);
};



const handleYouTubeUrl = (url) => {
    const videoId = getYouTubeVideoId(url);
    if (videoId) {
        const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
        const videoData = {
            type: "youtube",
            url: url,
            thumbnail: thumbnailUrl
        };
        appendEntriesAndPersist([videoData]);
    } else {
        console.error("Invalid YouTube URL.");
    }
};

const buildCodepenEntry = (url) => {
    if (typeof url !== "string") return null;
    const normalizedUrl = url.trim();
    const match = normalizedUrl.match(/^https?:\/\/(?:www\.)?codepen\.io\/([^\/]+)\/(?:pen|full)\/([^\/?#]+)/i);
    if (!match) return null;

    const username = match[1];
    const id = match[2];

    return {
        type: "codepen",
        url: normalizedUrl,
        thumbnail: `https://shots.codepen.io/${username}/pen/${id}-800.jpg`,
        thumbnailFallback: `https://shots.codepen.io/${username}/pen/${id}-800.webp`
    };
};

const handleCodepenUrl = (url) => {
    const codepenData = buildCodepenEntry(url);
    if (codepenData) {
        appendEntriesAndPersist([codepenData]);
    } else {
        console.error("Invalid Codepen URL.");
    }
};

const upgradeCodepenEntries = (items = []) => {
    let didChange = false;

    const upgradedItems = items.map((item) => {
        if (typeof item === "string") {
            const entry = buildCodepenEntry(item);
            if (entry) {
                didChange = true;
                return entry;
            }
            return item;
        }

        if (!item || typeof item !== "object") return item;

        if (item.type === "codepen") {
            if (!item.thumbnail || typeof item.thumbnail !== "string") {
                const entry = buildCodepenEntry(item.url || "");
                if (entry) {
                    didChange = true;
                    return { ...entry, url: item.url || entry.url };
                }
            }
            return item;
        }

        if (item.type === "link" && typeof item.url === "string") {
            const entry = buildCodepenEntry(item.url);
            if (entry) {
                didChange = true;
                return entry;
            }
        }

        return item;
    });

    return { items: upgradedItems, didChange };
};


const handleGenericLink = (url) => {
    if (isCodepenUrl(url)) {
        handleCodepenUrl(url);
        return;
    }
    const linkData = {
        type: "link",
        url: url
    };
    appendEntriesAndPersist([linkData]);
};

const isImageUrl = (url) => {
    return url.toLowerCase().match(/\.(jpeg|jpg|gif|png|webp)$/) !== null;
};

const isYouTubeUrl = (url) => {
    const pattern = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\/.+$/;
    return pattern.test(url);
};

const isCodepenUrl = (url) => {
    const pattern = /^https?:\/\/(?:www\.)?codepen\.io\/[^\/]+\/(?:pen|full)\/[^\/?#]+/i;
    return pattern.test(url);
};

const getYouTubeVideoId = (url) => {
    const match = url.match(/[?&]v=([^&#]*)|youtu\.be\/([^&#]*)/);
    return match ? match[1] || match[2] : null;
};

const renderImages = () => {
    let images = "";

    files.forEach((e, i) => {
        if (typeof e === "string") { // Regular image
            const imgTag = e.toLowerCase().endsWith(".gif") 
                ? `<gif-player src="${e}" class="imglook" id="gif-${i}" data-preview-index="${i}" speed="1" size="cover"></gif-player>` 
                : `<img class="imglook" src="${e}" id="img-${i}" data-preview-index="${i}" loading="lazy" decoding="async">`;

            images += `
                <div class="hidden" draggable="true" data-item-index="${i}">
                    <div class="holder">
                        ${imgTag}
                        <span onclick="deleteImage(${i})">&#10006;</span>
                    </div>
                </div>`;
        } else if (e.type === "gif") { // GIF player
            images += `
                <div class="hidden" draggable="true" data-item-index="${i}">
                    <div class="holder">
                        <gif-player src="${e.src}" class="imglook" id="gif-${i}" data-preview-index="${i}" size="cover"></gif-player>
                        <span onclick="deleteImage(${i})">&#10006;</span>
                    </div>
                </div>`;
        } else if (e.type === "youtube") { // YouTube video thumbnail
            images += `
                <div class="hidden" draggable="true" data-item-index="${i}">
                    <div class="holder">
                        <a href="${e.url}" target="_blank">
                            <img src="${e.thumbnail}" alt="YouTube Video" loading="lazy" decoding="async">
                        </a>
                        <span onclick="deleteImage(${i})">&#10006;</span>
                    </div>
                </div>`;
        } else if (e.type === "codepen") { // Codepen thumbnail
            images += `
                <div class="hidden" draggable="true" data-item-index="${i}">
                    <div class="holder">
                        <a href="${e.url}" target="_blank">
                            <img src="${e.thumbnail}" alt="Codepen Preview" loading="lazy" decoding="async" data-fallback="${e.thumbnailFallback || ""}">
                        </a>
                        <span onclick="deleteImage(${i})">&#10006;</span>
                    </div>
                </div>`;
        } else if (e.type === "link") { // Generic link
            images += `
                <div class="hidden" draggable="true" data-item-index="${i}">
                    <div class="holder link-holder">
                        <a href="${e.url}" target="_blank" class="link-box">${e.url}</a>
                        <span onclick="deleteImage(${i})">&#10006;</span>
                    </div>
                </div>`;
        }
    });

    cardContainer.innerHTML = images;
    cardContainer.querySelectorAll("img[data-fallback]").forEach((img) => {
        const fallback = img.dataset.fallback;
        if (!fallback) return;
        img.addEventListener("error", () => {
            if (img.dataset.fallbackApplied === "1") return;
            img.dataset.fallbackApplied = "1";
            img.src = fallback;
        });
    });
    applyGifInteractionMode(cardContainer);
    setupGridGifSizing(cardContainer);
    observeHiddenElements();
};

// Updated showImages function
const showImages = () => {
    if (renderAnimationFrameId !== null) return;

    renderAnimationFrameId = requestAnimationFrame(() => {
        renderAnimationFrameId = null;
        if (typeof document.startViewTransition === "function" && !activeDragItem) {
            document.startViewTransition(() => renderImages());
        } else {
            renderImages();
        }
    });
};

cardContainer.addEventListener("dragstart", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const sourceCard = target.closest(".hidden");
    if (!sourceCard || !cardContainer.contains(sourceCard)) return;

    activeDragItem = sourceCard;

    if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(INTERNAL_REORDER_MIME, "live-reorder");
        event.dataTransfer.setData("text/plain", "");
    }

    setTimeout(() => {
        if (activeDragItem) activeDragItem.classList.add("dragging");
    }, 0);
});

cardContainer.addEventListener("dragover", (event) => {
    if (!isInternalReorderDrag(event.dataTransfer) || !activeDragItem) return;

    event.preventDefault(); // allow drop
    if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
    }

    const target = event.target;
    if (!(target instanceof Element)) return;

    const targetCard = target.closest(".hidden");
    if (!targetCard || targetCard === activeDragItem || !cardContainer.contains(targetCard)) return;

    // Live DOM swapping
    const allCards = Array.from(cardContainer.querySelectorAll(".hidden"));
    const draggedIndex = allCards.indexOf(activeDragItem);
    const targetIndex = allCards.indexOf(targetCard);

    if (draggedIndex === -1 || targetIndex === -1) return;

    if (draggedIndex < targetIndex) {
        targetCard.after(activeDragItem);
    } else {
        targetCard.before(activeDragItem);
    }
});

cardContainer.addEventListener("drop", (event) => {
    if (!isInternalReorderDrag(event.dataTransfer) && !activeDragItem) return;
    event.preventDefault();
    event.stopPropagation();
});

cardContainer.addEventListener("dragend", () => {
    if (!activeDragItem) return;

    activeDragItem.classList.remove("dragging");

    // Read the new sorted DOM to recreate the array
    const newCardsOrder = Array.from(cardContainer.querySelectorAll(".hidden"));
    const newFiles = newCardsOrder.map((card) => {
        const originalIndex = Number(card.dataset.itemIndex);
        return files[originalIndex];
    }).filter(item => typeof item !== "undefined");

    files.length = 0;
    files.push(...newFiles);

    activeDragItem = null;

    showImages(); // Re-render to refresh indices
    saveToLocalStorage();
});

cardContainer.addEventListener("click", (event) => {
    const mediaElement = event.target.closest(".imglook");
    if (!mediaElement || !cardContainer.contains(mediaElement)) return;

    const holder = mediaElement.closest(".holder");
    if (!holder) return;

    const isYouTubeCard = Boolean(holder.querySelector("a[href*='youtube']"));
    const isCodepenCard = Boolean(holder.querySelector("a[href*='codepen']"));
    if (isYouTubeCard || isCodepenCard) return;

    const index = Number(mediaElement.dataset.previewIndex);
    if (!Number.isFinite(index)) return;

    currentPreviewIndex = index;
    showPreview(currentPreviewIndex);
});

const closePreview = () => {
    const previewContainer = document.querySelector(".PopUpPreview");
    if (!previewContainer) return;

    if (typeof previewContainer._cleanupGifControls === "function") {
        previewContainer._cleanupGifControls();
        previewContainer._cleanupGifControls = null;
    }

    previewContainer.style.display = "none";
    document.body.classList.remove("popup-active");
    currentPreviewIndex = -1;
};

const setupGifPlaybackControls = (previewContainer) => {
    if (activeGifMode !== GIF_MODES.PLAYBACK) return;

    const gifPlayer = previewContainer.querySelector(".popup-gif");
    const controls = previewContainer.querySelector(".gif-controls");
    if (!gifPlayer || !controls) return;

    // Ensure preview GIF is played at normal speed by default.
    gifPlayer.speed = 1;
    gifPlayer.setAttribute("speed", "1");

    if (typeof gifPlayer.start !== "function" || typeof gifPlayer.stop !== "function") {
        if (window.customElements && typeof window.customElements.whenDefined === "function") {
            window.customElements.whenDefined("gif-player").then(() => {
                if (previewContainer.style.display === "block") {
                    setupGifPlaybackControls(previewContainer);
                }
            });
        }
        return;
    }

    const playPauseBtn = controls.querySelector(".gif-play-pause");
    const previousFrameBtn = controls.querySelector(".gif-prev-frame");
    const nextFrameBtn = controls.querySelector(".gif-next-frame");
    const frameSlider = controls.querySelector(".gif-frame-slider");
    const frameLabel = controls.querySelector(".gif-frame-label");

    if (!playPauseBtn || !previousFrameBtn || !nextFrameBtn || !frameSlider || !frameLabel) {
        return;
    }

    playPauseBtn.style.minWidth = "58px";
    playPauseBtn.style.textAlign = "center";


    const getFrameCount = () => {
        if (gifPlayer._frames && gifPlayer._frames.length) return gifPlayer._frames.length;
        if (gifPlayer._gif && typeof gifPlayer._gif.numFrames === "function") return gifPlayer._gif.numFrames();
        return 1;
    };

    let hasStartedPlayback = false;
    let isDraggingSlider = false;

    const isActivelyPlaying = () => {
        return hasStartedPlayback && gifPlayer.playing && !gifPlayer.paused;
    };

    const pauseGifPlayback = () => {
        const currentFrame = Number(gifPlayer.frame) || 0;

        if (typeof gifPlayer.pausePlayback === "function") {
            gifPlayer.pausePlayback();
        }

        if (typeof gifPlayer.stop === "function") {
            gifPlayer.stop();
        }

        gifPlayer.frame = currentFrame;
        gifPlayer.paused = true;
        hasStartedPlayback = true;
    };

    const resumeGifPlayback = () => {
        if (typeof gifPlayer.start === "function" && !gifPlayer.playing) {
            gifPlayer.start();
        }

        gifPlayer.paused = false;
        hasStartedPlayback = true;
    };

    const updatePlayPauseLabel = () => {
        playPauseBtn.textContent = isActivelyPlaying() ? "⏸" : "▶";
    };

    const updateFrameUi = () => {
        const totalFrames = Math.max(getFrameCount(), 1);
        const currentFrame = Math.max(0, Math.min(Number(gifPlayer.frame) || 0, totalFrames - 1));
        const frameLabelWidthCh = (String(totalFrames).length * 2) + 3;

        frameSlider.min = "0";
        frameSlider.max = String(totalFrames - 1);
        if (!isDraggingSlider) {
            frameSlider.value = String(currentFrame);
        }
        frameSlider.disabled = totalFrames <= 1;
        frameLabel.style.width = `${frameLabelWidthCh}ch`;
        
        const displayFrame = isDraggingSlider ? Number(frameSlider.value) : currentFrame;
        frameLabel.textContent = `${displayFrame + 1} / ${totalFrames}`;
        updatePlayPauseLabel();
    };

    const seekToFrame = (frameIndex) => {
        const totalFrames = Math.max(getFrameCount(), 1);
        const clampedFrame = Math.max(0, Math.min(frameIndex, totalFrames - 1));
        pauseGifPlayback();
        gifPlayer.frame = clampedFrame;
        updateFrameUi();
    };

    const onGifFrame = () => {
        updateFrameUi();
    };

    const onGifLoaded = () => {
        gifPlayer.stop();
        gifPlayer.paused = true;
        hasStartedPlayback = false;
        gifPlayer.frame = 0;
        updateFrameUi();
    };

    playPauseBtn.addEventListener("click", () => {
        if (isActivelyPlaying()) {
            pauseGifPlayback();
        } else {
            resumeGifPlayback();
        }
        updatePlayPauseLabel();
    });

    previousFrameBtn.addEventListener("click", () => {
        seekToFrame((Number(gifPlayer.frame) || 0) - 1);
    });

    nextFrameBtn.addEventListener("click", () => {
        seekToFrame((Number(gifPlayer.frame) || 0) + 1);
    });

    frameSlider.addEventListener("input", (event) => {
        isDraggingSlider = true;
        // Just update the label to feel responsive, but don't force synchronous frame decoding yet
        frameLabel.textContent = `${Number(event.target.value) + 1} / ${Math.max(getFrameCount(), 1)}`;
    });
    
    frameSlider.addEventListener("change", (event) => {
        isDraggingSlider = false;
        seekToFrame(Number(event.target.value));
    });

    gifPlayer.addEventListener("gif-loaded", onGifLoaded, { once: true });
    gifPlayer.addEventListener("gif-frame", onGifFrame);

    if (gifPlayer._gif) {
        onGifLoaded();
    } else {
        updateFrameUi();
    }

    previewContainer._cleanupGifControls = () => {
        pauseGifPlayback();
        gifPlayer.removeEventListener("gif-frame", onGifFrame);
    };
};

// Function to show preview for a specific index
const showPreview = (index) => {
    if (index < 0 || index >= files.length) return;
    
    const file = files[index];
    const previewContainer = document.querySelector(".PopUpPreview");

    if (typeof previewContainer._cleanupGifControls === "function") {
        previewContainer._cleanupGifControls();
        previewContainer._cleanupGifControls = null;
    }

    previewContainer.style.display = "block";
    document.body.classList.add("popup-active");
    let previewContent = '';
    
    if (typeof file === "string") {
        if (file.toLowerCase().endsWith(".gif")) {
            previewContent = `
                <span class="preview-close">&#10006;</span>
                <div class="popup-gif-stage">
                    <gif-player src="${file}" class="popup-gif" speed="1"></gif-player>
                    ${activeGifMode === GIF_MODES.PLAYBACK ? `
                    <div class="gif-controls">
                        <button type="button" class="gif-prev-frame" title="Previous frame">⏮</button>
                        <button type="button" class="gif-play-pause" title="Play / Pause">⏯</button>
                        <button type="button" class="gif-next-frame" title="Next frame">⏭</button>
                        <input type="range" class="gif-frame-slider" min="0" max="0" value="0" step="1">
                        <div class="gif-frame-label">1 / 1</div>
                    </div>
                    ` : ""}
                </div>
            `;
        } else {
            previewContent = `
                <span class="preview-close">&#10006;</span>
                <img src="${file}" alt="Preview">
            `;
        }
    } else if (file.type === "gif") {
        previewContent = `
            <span class="preview-close">&#10006;</span>
            <div class="popup-gif-stage">
                <gif-player src="${file.src}" class="popup-gif" speed="1"></gif-player>
                ${activeGifMode === GIF_MODES.PLAYBACK ? `
                <div class="gif-controls">
                    <button type="button" class="gif-prev-frame" title="Previous frame">⏮</button>
                    <button type="button" class="gif-play-pause" title="Play / Pause">⏯</button>
                    <button type="button" class="gif-next-frame" title="Next frame">⏭</button>
                    <input type="range" class="gif-frame-slider" min="0" max="0" value="0" step="1">
                    <div class="gif-frame-label">1 / 1</div>
                </div>
                ` : ""}
            </div>
        `;
    } else if (file.type === "youtube") {
        previewContent = `
            <span class="preview-close">&#10006;</span>
            <a href="${file.url}" target="_blank">
                <img src="${file.thumbnail}" alt="YouTube Video Preview">
            </a>
        `;
    } else if (file.type === "codepen") {
        previewContent = `
            <span class="preview-close">&#10006;</span>
            <a href="${file.url}" target="_blank">
                <img src="${file.thumbnail}" alt="Codepen Preview">
            </a>
        `;
    } else if (file.type === "link") {
        previewContent = `
            <span class="preview-close">&#10006;</span>
            <div class="link-preview">
                <a href="${file.url}" target="_blank" class="link-box">${file.url}</a>
            </div>
        `;
    }
    
    previewContainer.innerHTML = previewContent;
    applyGifInteractionMode(previewContainer);
    setupGifPlaybackControls(previewContainer);
    
    // Add close button functionality
    const closeBtn = document.querySelector(".PopUpPreview .preview-close");
    if (closeBtn) {
        closeBtn.onclick = () => {
            closePreview();
        };
    }
};

// Function to navigate to previous image
const showPreviousImage = () => {
    if (currentPreviewIndex > 0) {
        currentPreviewIndex--;
        showPreview(currentPreviewIndex);
    }
};

// Function to navigate to next image
const showNextImage = () => {
    if (currentPreviewIndex < files.length - 1) {
        currentPreviewIndex++;
        showPreview(currentPreviewIndex);
    }
};

// Enhanced keyboard event handling
document.addEventListener("keydown", (e) => {
    const previewContainer = document.querySelector(".PopUpPreview");
    const isPreviewVisible = previewContainer.style.display === "block";
    
    if (isPreviewVisible) {
        switch(e.key) {
            case "Escape":
                closePreview();
                break;
            case "ArrowLeft":
                e.preventDefault();
                showPreviousImage();
                break;
            case "ArrowRight":
                e.preventDefault();
                showNextImage();
                break;
        }
    }
});


const deleteImage = (index) => {
    files.splice(index, 1);
    showImages();
    saveToLocalStorage();
};

const observeHiddenElements = () => {
    const hiddenElements = cardContainer.querySelectorAll(".hidden");

    if (hiddenElementsObserver) {
        hiddenElementsObserver.disconnect();
    }

    hiddenElementsObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                entry.target.classList.add("showx");
            } else {
                entry.target.classList.remove("showx");
            }

            const gridGifPlayer = entry.target.querySelector(".holder gif-player");
            if (!gridGifPlayer || typeof gridGifPlayer.stop !== "function") {
                return;
            }

            if (typeof gridGifPlayer.pausePlayback === "function") {
                gridGifPlayer.pausePlayback();
            }
            gridGifPlayer.stop();
            gridGifPlayer.paused = true;
            if (!isScrollModeActive()) {
                gridGifPlayer.frame = 0;
            }
        });
    }, {
        root: null,
        rootMargin: "280px 0px",
        threshold: 0.01
    });

    hiddenElements.forEach((element) => {
        hiddenElementsObserver.observe(element);
    });
};

const saveToLocalStorage = () => {
    schedulePersistFiles({ delayMs: 450, silent: false });
};

// Save images to local storage before the page unloads
window.addEventListener("beforeunload", () => {
    void flushScheduledPersistence({ silent: true }).catch(() => undefined);
});

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
        void flushScheduledPersistence({ silent: true }).catch(() => undefined);
    }
});

// Initial call to showImages to load any pre-existing images
showImages();

const handleKeyPress = (event) => {
    if (event.key === "Enter") {
        addImageUrl();
    }
};
const addImageUrl = () => {
    const imageUrlInput = document.getElementById("imageUrlInput");
    const imageUrl = imageUrlInput.value.trim();

    if (imageUrl !== "") {
        if (isYouTubeUrl(imageUrl)) {
            handleYouTubeUrl(imageUrl);
        } else if (isCodepenUrl(imageUrl)) {
            handleCodepenUrl(imageUrl);
        } else if (isImageUrl(imageUrl)) {
            handleDroppedUrl(imageUrl);
        } else {
            handleGenericLink(imageUrl);
        }
        imageUrlInput.value = "";
    }
};

const clearButton = document.getElementById("clearButton");
const clearDatabaseAndFiles = async () => {
    if (confirm("Are you sure you want to delete all images?")) {
        files = [];
        showImages();
        await storageAdapter.clearFiles();
        showStorageStatus("Cleared saved browser data.", "info", 5000);
    }
};
clearButton.addEventListener("click", () => {
    void clearDatabaseAndFiles();
});

// Export to JSON functionality
const exportButton = document.getElementById("exportButton");
const exportToJSON = () => {
    const jsonString = JSON.stringify(files, null, 2);
    const blob = new Blob([jsonString], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "images-export.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};
exportButton.addEventListener("click", exportToJSON);

// Import from JSON functionality
const importButton = document.getElementById("importButton");
const jsonInput = document.getElementById("jsonInput");

const importFromJSON = () => {
    jsonInput.click();
};

importButton.addEventListener("click", importFromJSON);

jsonInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = async (event) => {
            let importedData;

            try {
                importedData = JSON.parse(event.target.result);
            } catch (error) {
                alert("Error parsing JSON file: " + error.message);
                return;
            }

            try {
                if (!Array.isArray(importedData)) {
                    alert("Invalid JSON format. Expected an array.");
                    return;
                }

                const { accepted, rejected } = sanitizeImportedItems(importedData);
                const upgraded = upgradeCodepenEntries(accepted);
                const acceptedItems = upgraded.items;
                if (acceptedItems.length === 0) {
                    alert("Import failed. No valid entries were found in the selected JSON file.");
                    return;
                }

                const mergedFiles = [...files, ...acceptedItems];
                const incomingSize = estimateSerializedSize(acceptedItems);
                const usageEstimate = await storageAdapter.getUsageEstimate();

                if (usageEstimate && usageEstimate.quota && usageEstimate.usage) {
                    const remaining = Math.max(usageEstimate.quota - usageEstimate.usage, 0);
                    if (incomingSize > remaining && remaining > 0) {
                        showStorageStatus(
                            `Large import detected (${formatBytes(incomingSize)}). If saving fails, export JSON to Windows immediately.`,
                            "warning",
                            9000
                        );
                    }
                }

                files = mergedFiles;
                showImages();

                try {
                    await persistFiles(files, { silent: true });
                    const importMessage = rejected > 0
                        ? `Import complete. Added ${acceptedItems.length} item(s), skipped ${rejected} invalid item(s).`
                        : `Import complete. Added ${acceptedItems.length} item(s).`;

                    alert(importMessage);
                    showStorageStatus("Import saved to browser storage.", "success", 6000);
                } catch (error) {
                    if (isQuotaExceededError(error)) {
                        showStorageStatus("Storage is full. Export JSON to save your current collection on Windows.", "warning", 10000);
                        alert("The imported content is visible now, but browser storage is full. Export JSON now so your collection is not lost.");
                    } else {
                        throw error;
                    }
                }
            } catch (error) {
                alert("Import failed: " + error.message);
            }
        };
        reader.readAsText(file);
        // Reset the input so the same file can be selected again
        jsonInput.value = "";
    }
});

