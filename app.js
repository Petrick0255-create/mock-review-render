const pdfjsLib = globalThis.pdfjsLib;

if (pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const PDF_OPTIONS = {
  cMapUrl: "./vendor/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "./vendor/standard_fonts/",
};

let currentMode = "view";
let appMode = null;
let currentTool = "pen";
let currentColor = "#172033";
let activePane = null;
let currentQuestion = 1;
let syncGuard = false;
let toastTimer = 0;

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 2600);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function readCompleteFile(file, label) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100)));
      $("#busyLabel").textContent = `${label} PDF 전체 읽는 중… ${percent}%`;
    };
    reader.onerror = () => reject(new Error(`${label} PDF를 끝까지 읽지 못했습니다.`));
    reader.onabort = () => reject(new Error(`${label} PDF 읽기가 중단되었습니다.`));
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.readAsArrayBuffer(file);
  });
}

class InkDatabase {
  constructor() {
    this.fallbackPrefix = "pdf-note-compare:";
    this.promise = new Promise((resolve) => {
      if (!("indexedDB" in window)) return resolve(null);
      const request = indexedDB.open("pdf-note-compare", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("pages");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
  }

  async get(key) {
    const db = await this.promise;
    if (!db) {
      try { return JSON.parse(localStorage.getItem(this.fallbackPrefix + key) || "[]"); }
      catch { return []; }
    }
    return new Promise((resolve) => {
      const request = db.transaction("pages", "readonly").objectStore("pages").get(key);
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
      request.onerror = () => resolve([]);
    });
  }

  async put(key, value) {
    const db = await this.promise;
    if (!db) {
      try { localStorage.setItem(this.fallbackPrefix + key, JSON.stringify(value)); } catch { /* full storage */ }
      return;
    }
    const transaction = db.transaction("pages", "readwrite");
    transaction.objectStore("pages").put(value, key);
  }
}

const inkDatabase = new InkDatabase();

class PdfPane {
  constructor(side) {
    this.side = side;
    this.other = null;
    this.document = null;
    this.loadingTask = null;
    this.sourceFile = null;
    this.objectUrl = null;
    this.nativeUrl = null;
    this.fingerprint = "";
    this.pageNumber = 1;
    this.currentQuestion = 1;
    this.rawCandidates = [];
    this.questions = new Map();
    this.detectedColumns = 1;
    this.zoom = 1;
    this.renderTask = null;
    this.renderSerial = 0;
    this.strokes = [];
    this.drawing = null;
    this.pointerId = null;
    this.drawingPointerType = null;
    this.touchPointers = new Map();
    this.touchStartSnapshot = null;
    this.panGesture = null;
    this.suppressTouchInk = false;
    this.lastScrollTop = 0;
    this.lastScrollLeft = 0;
    this.saveTimer = 0;
    this.inkDpr = 1;
    this.compareRange = [1, 1];
    this.compareUnits = [];
    this.compareObserver = null;
    this.compareGeneration = 0;
    this.compareQueue = [];
    this.activeCompareRenders = 0;

    this.viewportElement = $(`#${side}Viewport`);
    this.stage = $(`#${side}Stage`);
    this.pdfCanvas = $(`#${side}Pdf`);
    this.inkCanvas = $(`#${side}Ink`);
    this.empty = $(`#${side}Empty`);
    this.nativeFrame = $(`#${side}Native`);
    this.nameElement = $(`#${side}Name`);
    this.pageInput = $(`#${side}Page`);
    this.totalElement = $(`#${side}Total`);
    this.continuousElement = $(`#${side}Continuous`);

    $(`#${side}Prev`).addEventListener("click", () => {
      if (appMode === "compare") this.scrollComparePage(this.pageNumber - 1);
      else goQuestion(currentQuestion - 1);
    });
    $(`#${side}Next`).addEventListener("click", () => {
      if (appMode === "compare") this.scrollComparePage(this.pageNumber + 1);
      else goQuestion(currentQuestion + 1);
    });
    $(`#${side}Layout`).addEventListener("change", () => {
      if (appMode === "compare") {
        this.buildCompare(true).catch((error) => toast(error.message));
      } else {
        this.rebuildQuestionIndex();
        this.renderQuestion(currentQuestion).catch((error) => toast(error.message));
        updateDetectionStatus();
      }
    });
    this.pageInput.addEventListener("change", () => {
      if (appMode === "compare") this.scrollComparePage(this.pageInput.value);
    });
    this.viewportElement.addEventListener("scroll", () => this.syncScroll());
    this.viewportElement.addEventListener("pointerdown", () => { activePane = this; }, { passive: true });
    this.bindInkEvents();
  }

  get pageCount() { return this.document?.numPages || 0; }
  get layoutColumns() {
    const selected = $(`#${this.side}Layout`).value;
    return selected === "auto" ? this.detectedColumns : Number(selected);
  }
  get inkKey() { return `${this.fingerprint}:question:${this.currentQuestion}:columns-${this.layoutColumns}`; }

  async openDocument(file) {
    if (!pdfjsLib) throw new Error("이 Safari에서 PDF 분석 모듈을 시작하지 못했습니다.");
    if (!file || (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf")) {
      throw new Error("PDF 파일만 열 수 있습니다.");
    }
    if (this.renderTask) this.renderTask.cancel();
    this.compareObserver?.disconnect();
    this.compareGeneration += 1;
    this.compareUnits = [];
    this.compareQueue = [];
    this.continuousElement.replaceChildren();
    if (this.loadingTask?.destroy) await this.loadingTask.destroy();
    else if (this.document?.destroy) await this.document.destroy();
    this.document = null;
    this.loadingTask = null;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);

    this.sourceFile = file;
    const label = this.side === "left" ? (appMode === "compare" ? "원본" : "문제") : (appMode === "compare" ? "비교본" : "해설");
    const completeData = await readCompleteFile(file, label);
    $("#busyLabel").textContent = `${label} PDF 구조 확인 중…`;
    const loadingTask = pdfjsLib.getDocument({
      data: completeData,
      ...PDF_OPTIONS,
      useSystemFonts: true,
    });
    this.loadingTask = loadingTask;
    loadingTask.onPassword = (updatePassword) => {
      const password = window.prompt(`${file.name}\nPDF 비밀번호를 입력하세요.`);
      if (password !== null) updatePassword(password);
    };
    this.document = await loadingTask.promise;
    this.fingerprint = this.document.fingerprints?.[0] || `${file.name}:${file.size}:${file.lastModified}`;
    this.pageNumber = 1;
    this.nameElement.textContent = file.name;
    this.nameElement.title = file.name;
    this.totalElement.textContent = String(this.pageCount);
    this.pageInput.max = String(this.pageCount);
    this.empty.classList.add("hidden");
    this.nativeFrame.classList.add("hidden");
    this.continuousElement.classList.add("hidden");
  }

  async load(file) {
    await this.openDocument(file);
    this.stage.classList.remove("hidden");
    await this.scanQuestions();
    await this.renderQuestion(currentQuestion);
  }

  async loadCompare(file) {
    await this.openDocument(file);
    this.stage.classList.add("hidden");
    this.continuousElement.classList.remove("hidden");
    this.compareRange = [1, this.pageCount];
    await this.buildCompare(false);
  }

  showNative(file) {
    if (this.nativeUrl) URL.revokeObjectURL(this.nativeUrl);
    this.nativeUrl = URL.createObjectURL(file);
    this.stage.classList.add("hidden");
    this.continuousElement.classList.add("hidden");
    this.empty.classList.add("hidden");
    this.nativeFrame.src = this.nativeUrl;
    this.nativeFrame.classList.remove("hidden");
    this.nameElement.textContent = file.name;
    this.nameElement.title = file.name;
    this.totalElement.textContent = "—";
  }

  compareColumns() {
    const value = $(`#${this.side}Layout`).value;
    return value === "2" ? 2 : 1;
  }

  async setCompareRange(start, end) {
    const first = Math.max(1, Math.min(this.pageCount, Math.round(Number(start) || 1)));
    const last = Math.max(first, Math.min(this.pageCount, Math.round(Number(end) || this.pageCount)));
    this.compareRange = [first, last];
    await this.buildCompare(false);
  }

  async buildCompare(preservePosition = false) {
    if (!this.document || appMode !== "compare") return;
    const generation = ++this.compareGeneration;
    const oldHeight = this.viewportElement.scrollHeight;
    const oldCenter = this.viewportElement.scrollTop + this.viewportElement.clientHeight / 2;
    const positionRatio = oldHeight ? oldCenter / oldHeight : 0;
    this.compareObserver?.disconnect();
    this.compareUnits = [];
    this.compareQueue = [];
    this.continuousElement.replaceChildren();
    this.continuousElement.classList.remove("hidden");
    this.stage.classList.add("hidden");
    this.nativeFrame.classList.add("hidden");
    this.empty.classList.add("hidden");

    const columns = this.compareColumns();
    const availableWidth = Math.max(220, this.viewportElement.clientWidth - 24);
    const samplePage = await this.document.getPage(this.compareRange[0]);
    if (generation !== this.compareGeneration) return;
    const sampleBase = samplePage.getViewport({ scale: 1 });
    const sampleColumnWidth = sampleBase.width / columns;
    const sampleScale = (availableWidth / sampleColumnWidth) * this.zoom;
    const fragment = document.createDocumentFragment();
    for (let pageNumber = this.compareRange[0]; pageNumber <= this.compareRange[1]; pageNumber += 1) {
      for (let column = 0; column < columns; column += 1) {
        const element = document.createElement("div");
        element.className = "compare-unit";
        element.dataset.location = columns === 2
          ? `${pageNumber}쪽 · ${column === 0 ? "왼쪽 단" : "오른쪽 단"}`
          : `${pageNumber}쪽`;
        element.style.width = `${Math.ceil(sampleColumnWidth * sampleScale)}px`;
        element.style.height = `${Math.ceil(sampleBase.height * sampleScale)}px`;
        const canvas = document.createElement("canvas");
        element.append(canvas);
        const unit = { pageNumber, column, columns, availableWidth, base: sampleBase, scale: sampleScale, element, canvas, generation, rendered: false, rendering: false, queued: false, visible: false };
        this.compareUnits.push(unit);
        fragment.append(element);
      }
    }
    samplePage.cleanup?.();
    this.continuousElement.append(fragment);
    if (!preservePosition && this.compareUnits[0]) await this.renderCompareUnit(this.compareUnits[0]);
    if (generation !== this.compareGeneration) return;
    const unitByElement = new Map(this.compareUnits.map((unit) => [unit.element, unit]));
    this.compareObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const unit = unitByElement.get(entry.target);
        if (!unit) continue;
        unit.visible = entry.isIntersecting;
        if (entry.isIntersecting) this.queueCompareUnit(unit);
      }
      this.updateCompareLocation();
    }, { root: this.viewportElement, rootMargin: "1600px 0px", threshold: 0.01 });
    this.compareUnits.forEach((unit) => this.compareObserver.observe(unit.element));

    requestAnimationFrame(() => {
      this.viewportElement.scrollTop = preservePosition
        ? Math.max(0, positionRatio * this.viewportElement.scrollHeight - this.viewportElement.clientHeight / 2)
        : 0;
      this.viewportElement.scrollLeft = 0;
      this.updateCompareLocation();
      this.rememberScroll();
    });
  }

  queueCompareUnit(unit) {
    if (unit.rendered || unit.rendering || unit.queued || unit.generation !== this.compareGeneration) return;
    unit.queued = true;
    this.compareQueue.push(unit);
    this.pumpCompareQueue();
  }

  pumpCompareQueue() {
    if (this.activeCompareRenders >= 1) return;
    const unit = this.compareQueue.shift();
    if (!unit) return;
    unit.queued = false;
    if (unit.generation !== this.compareGeneration || unit.rendered || !unit.visible) return this.pumpCompareQueue();
    this.activeCompareRenders += 1;
    this.renderCompareUnit(unit).catch((error) => console.error(error)).finally(() => {
      this.activeCompareRenders -= 1;
      this.pumpCompareQueue();
    });
  }

  async renderCompareUnit(unit) {
    if (unit.rendered || unit.rendering || unit.generation !== this.compareGeneration) return;
    unit.rendering = true;
    const page = await this.document.getPage(unit.pageNumber);
    if (unit.generation !== this.compareGeneration) { unit.rendering = false; return; }
    const base = page.getViewport({ scale: 1 });
    const columnWidth = base.width / unit.columns;
    unit.base = base;
    unit.scale = (unit.availableWidth / columnWidth) * this.zoom;
    unit.element.style.width = `${Math.ceil(columnWidth * unit.scale)}px`;
    unit.element.style.height = `${Math.ceil(base.height * unit.scale)}px`;
    const targetPixels = columnWidth * unit.scale * base.height * unit.scale;
    const safeDpr = targetPixels > 2600000 ? 1 : 1.35;
    const dpr = Math.min(window.devicePixelRatio || 1, safeDpr);
    const viewport = page.getViewport({ scale: unit.scale * dpr });
    const pixelWidth = Math.ceil(viewport.width / unit.columns);
    unit.canvas.width = pixelWidth;
    unit.canvas.height = Math.ceil(viewport.height);
    const context = unit.canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#fff";
    context.fillRect(0, 0, unit.canvas.width, unit.canvas.height);
    const task = page.render({
      canvasContext: context,
      viewport,
      transform: [1, 0, 0, 1, -unit.column * pixelWidth, 0],
    });
    try { await task.promise; }
    catch (error) {
      if (error?.name !== "RenderingCancelledException") throw error;
      unit.rendering = false;
      return;
    }
    if (unit.generation !== this.compareGeneration) { unit.rendering = false; return; }
    const annotations = await page.getAnnotations({ intent: "display" });
    const cssViewport = page.getViewport({ scale: unit.scale });
    const cropLeft = unit.column * (cssViewport.width / unit.columns);
    const cropRight = cropLeft + cssViewport.width / unit.columns;
    for (const annotation of annotations) {
      const content = annotation.contentsObj?.str || annotation.contents || "";
      const author = annotation.titleObj?.str || annotation.title || "작성자 알 수 없음";
      if (!content && !annotation.rect) continue;
      const rectangle = annotation.rect ? cssViewport.convertToViewportRectangle(annotation.rect) : [cropLeft + 8, 8, cropLeft + 26, 26];
      const left = Math.min(rectangle[0], rectangle[2]);
      const top = Math.min(rectangle[1], rectangle[3]);
      const right = Math.max(rectangle[0], rectangle[2]);
      const bottom = Math.max(rectangle[1], rectangle[3]);
      if (right < cropLeft || left > cropRight) continue;
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = "annotation-marker";
      marker.style.left = `${Math.max(2, left - cropLeft)}px`;
      marker.style.top = `${Math.max(2, top)}px`;
      marker.style.width = `${Math.max(20, Math.min(cropRight, right) - Math.max(cropLeft, left))}px`;
      marker.style.height = `${Math.max(20, bottom - top)}px`;
      marker.setAttribute("aria-label", `메모: ${author}`);
      marker.innerHTML = `<span class="annotation-tooltip"><b>${escapeHtml(author)}</b><span>${escapeHtml(content || "내용 없는 주석")}</span></span>`;
      marker.addEventListener("click", () => marker.classList.toggle("open"));
      unit.element.append(marker);
    }
    unit.rendered = true;
    unit.rendering = false;
    page.cleanup?.();
  }

  updateCompareLocation() {
    if (appMode !== "compare" || !this.compareUnits.length) return;
    const viewportTop = this.viewportElement.getBoundingClientRect().top;
    const unit = this.compareUnits.reduce((best, item) => {
      const distance = Math.abs(item.element.getBoundingClientRect().top - viewportTop - 8);
      return !best || distance < best.distance ? { item, distance } : best;
    }, null)?.item;
    if (!unit) return;
    this.pageNumber = unit.pageNumber;
    this.pageInput.value = String(unit.pageNumber);
    const currentIndex = this.compareUnits.indexOf(unit);
    for (let index = 0; index < this.compareUnits.length; index += 1) {
      const candidate = this.compareUnits[index];
      if (Math.abs(index - currentIndex) <= 14 || !candidate.rendered) continue;
      candidate.element.querySelectorAll(".annotation-marker").forEach((marker) => marker.remove());
      candidate.canvas.width = 1;
      candidate.canvas.height = 1;
      candidate.rendered = false;
    }
  }

  scrollComparePage(value) {
    if (!this.compareUnits.length) return;
    const targetPage = Math.max(this.compareRange[0], Math.min(this.compareRange[1], Math.round(Number(value) || 1)));
    const target = this.compareUnits.find((unit) => unit.pageNumber === targetPage && unit.column === 0);
    target?.element.scrollIntoView({ block: "start", behavior: "smooth" });
    this.pageNumber = targetPage;
    this.pageInput.value = String(targetPage);
  }

  detectQuestionNumber(text) {
    const normalized = text.replace(/\s+/g, " ").trim();
    const patterns = [
      /^(?:문항\s*)?(0?[1-9]|1\d|2[0-5])\s*번(?:\s|$)/,
      /^(0?[1-9]|1\d|2[0-5])\s*[.)](?:\s|$)/,
      /^[[(](0?[1-9]|1\d|2[0-5])[\])](?:\s|$)/,
      /^(0[1-9]|1\d|2[0-5])(?=[①-⑤])/,
      /^(0[1-9]|1\d|2[0-5])\s+(?=\S)/,
    ];
    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match) return Number(match[1]);
    }
    return null;
  }

  async scanQuestions() {
    this.rawCandidates = [];
    for (let pageNumber = 1; pageNumber <= this.pageCount; pageNumber += 1) {
      const page = await this.document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const positioned = content.items
        .filter((item) => item.str?.trim())
        .map((item) => {
          const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
          return { text: item.str, x: transform[4], y: transform[5], height: Math.abs(transform[3]) || 10 };
        })
        .sort((a, b) => Math.abs(a.y - b.y) > 3 ? a.y - b.y : a.x - b.x);

      const collectLines = (region, regionItems) => {
        const lines = [];
        for (const item of regionItems) {
          let line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= 3);
          if (!line) {
            line = { y: item.y, items: [] };
            lines.push(line);
          }
          line.items.push(item);
        }
        for (const line of lines) {
          line.items.sort((a, b) => a.x - b.x);
          const text = line.items.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
          const number = this.detectQuestionNumber(text);
          const anonymousAnswerHeading = number === null && /^(?:답\s*)?[①-⑤1-5]\s*-/.test(text);
          if (number !== null || anonymousAnswerHeading) {
            this.rawCandidates.push({
              number,
              region,
              page: pageNumber,
              x: line.items[0].x,
              y: Math.max(0, line.y - Math.max(...line.items.map((item) => item.height)) - 5),
              width: viewport.width,
              height: viewport.height,
              text,
            });
          }
        }
      };

      const middle = viewport.width / 2;
      collectLines("full", positioned);
      collectLines("left", positioned.filter((item) => item.x < middle));
      collectLines("right", positioned.filter((item) => item.x >= middle));
      page.cleanup?.();
    }
    const leftCount = new Set(this.rawCandidates.filter((item) => item.region === "left" && item.number).map((item) => item.number)).size;
    const rightCount = new Set(this.rawCandidates.filter((item) => item.region === "right" && item.number).map((item) => item.number)).size;
    this.detectedColumns = leftCount >= 3 && rightCount >= 3 ? 2 : 1;
    this.rebuildQuestionIndex();
  }

  rebuildQuestionIndex() {
    const columns = this.layoutColumns;
    const preferredRegion = columns === 2 ? ["left", "right"] : ["full"];
    let candidates = this.rawCandidates.filter((candidate) => preferredRegion.includes(candidate.region));
    if (candidates.filter((candidate) => candidate.number !== null).length < 8) candidates = [...this.rawCandidates];
    const unique = new Map();
    for (const candidate of candidates) {
      const column = columns === 2 && candidate.x >= candidate.width / 2 ? 1 : 0;
      const key = `${candidate.page}:${column}:${Math.round(candidate.y / 3)}:${candidate.number ?? "x"}`;
      if (!unique.has(key) || candidate.region !== "full") unique.set(key, candidate);
    }
    const ordered = [...unique.values()].sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      if (columns === 2) {
        const aColumn = a.x >= a.width / 2 ? 1 : 0;
        const bColumn = b.x >= b.width / 2 ? 1 : 0;
        if (aColumn !== bColumn) return aColumn - bColumn;
      }
      return Math.abs(a.y - b.y) > 3 ? a.y - b.y : a.x - b.x;
    });
    this.questions = new Map();
    let expected = 1;
    for (const candidate of ordered) {
      if (expected > 25) break;
      if (candidate.number === expected || candidate.number === null) {
        this.questions.set(expected, { ...candidate, number: expected, inferred: candidate.number === null });
        expected += 1;
      }
    }
  }

  questionSlices(number) {
    const start = this.questions.get(number);
    if (!start) return [];
    const nextNumber = [...this.questions.keys()].filter((value) => value > number).sort((a, b) => a - b)[0];
    const next = nextNumber ? this.questions.get(nextNumber) : null;
    const columns = this.layoutColumns;
    const startColumn = columns === 2 && start.x >= start.width / 2 ? 1 : 0;
    if (!next) {
      const finalSlices = [];
      let pageNumber = start.page;
      let column = startColumn;
      for (let guard = 0; guard < 4 && pageNumber <= this.pageCount; guard += 1) {
        const columnWidth = start.width / columns;
        const y = guard === 0 ? Math.max(8, start.y - 7) : 18;
        finalSlices.push({ page: pageNumber, x: column * columnWidth + 7, y, width: columnWidth - 14, height: start.height - y - 18 });
        column += 1;
        if (column >= columns) { column = 0; pageNumber += 1; }
      }
      return finalSlices;
    }
    const end = next;
    const endColumn = columns === 2 && end.x >= end.width / 2 ? 1 : 0;
    const slices = [];
    let pageNumber = start.page;
    let column = startColumn;
    for (let guard = 0; guard < 10; guard += 1) {
      const pageMarker = this.rawCandidates.find((item) => item.page === pageNumber) || start;
      const width = pageMarker.page === pageNumber ? pageMarker.width : start.width;
      const height = pageMarker.page === pageNumber ? pageMarker.height : start.height;
      const sameAsStart = pageNumber === start.page && column === startColumn;
      const sameAsEnd = pageNumber === end.page && column === endColumn;
      const columnWidth = width / columns;
      const x = column * columnWidth + 7;
      const y = sameAsStart ? Math.max(8, start.y - 7) : 18;
      const bottom = sameAsEnd ? Math.max(y + 12, end.y - 9) : height - 18;
      if (bottom > y + 8) slices.push({ page: pageNumber, x, y, width: columnWidth - 14, height: bottom - y });
      if (sameAsEnd) break;
      column += 1;
      if (column >= columns) { column = 0; pageNumber += 1; }
      if (pageNumber > this.pageCount) break;
    }
    return slices;
  }

  async setZoom(value) {
    this.zoom = value;
    if (!this.document) return;
    if (appMode === "compare") await this.buildCompare(true);
    else await this.renderQuestion(this.currentQuestion, true);
  }

  async renderQuestion(number, preservePosition = false) {
    if (!this.document) return;
    const marker = this.questions.get(number);
    if (!marker) {
      this.empty.classList.remove("hidden");
      this.empty.innerHTML = `<b>${String(number).padStart(2, "0")}번을 찾지 못했습니다</b><span>문서 형식을 바꾸거나 텍스트가 포함된 PDF인지 확인해 주세요.</span>`;
      this.stage.classList.add("hidden");
      return;
    }
    this.empty.classList.add("hidden");
    this.stage.classList.remove("hidden");
    this.currentQuestion = number;
    this.pageNumber = marker.page;
    const serial = ++this.renderSerial;
    const xRatio = preservePosition && this.viewportElement.scrollWidth > this.viewportElement.clientWidth
      ? (this.viewportElement.scrollLeft + this.viewportElement.clientWidth / 2) / this.viewportElement.scrollWidth : 0.5;
    const yRatio = preservePosition && this.viewportElement.scrollHeight > this.viewportElement.clientHeight
      ? (this.viewportElement.scrollTop + this.viewportElement.clientHeight / 2) / this.viewportElement.scrollHeight : 0;

    if (this.renderTask) {
      try { this.renderTask.cancel(); } catch { /* already complete */ }
    }
    const slices = this.questionSlices(number);
    const maxBaseWidth = Math.max(...slices.map((slice) => slice.width));
    const totalBaseHeight = slices.reduce((sum, slice) => sum + slice.height, 0) + Math.max(0, slices.length - 1) * 10;
    const availableWidth = Math.max(260, this.viewportElement.clientWidth - 28);
    const toolbarAllowance = currentMode === "ink" ? 62 : 0;
    const availableHeight = Math.max(220, this.viewportElement.clientHeight - 16 - toolbarAllowance);
    let scale = Math.min(availableWidth / maxBaseWidth, availableHeight / totalBaseHeight) * this.zoom;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    scale = Math.min(scale, 28000 / Math.max(1, totalBaseHeight * dpr));
    const width = Math.ceil(maxBaseWidth * scale);
    const height = Math.ceil(totalBaseHeight * scale);

    this.stage.style.width = `${width}px`;
    this.stage.style.height = `${height}px`;
    this.pdfCanvas.width = Math.ceil(width * dpr);
    this.pdfCanvas.height = Math.ceil(height * dpr);
    this.pdfCanvas.style.width = `${width}px`;
    this.pdfCanvas.style.height = `${height}px`;
    this.inkCanvas.width = Math.ceil(width * dpr);
    this.inkCanvas.height = Math.ceil(height * dpr);
    this.inkCanvas.style.width = `${width}px`;
    this.inkCanvas.style.height = `${height}px`;

    this.inkDpr = dpr;
    const context = this.pdfCanvas.getContext("2d", { alpha: false });
    context.fillStyle = "#fff";
    context.fillRect(0, 0, this.pdfCanvas.width, this.pdfCanvas.height);
    let destinationY = 0;
    for (const slice of slices) {
      const page = await this.document.getPage(slice.page);
      if (serial !== this.renderSerial) return;
      const pageViewport = page.getViewport({ scale: scale * dpr });
      const temporary = document.createElement("canvas");
      temporary.width = Math.ceil(pageViewport.width);
      temporary.height = Math.ceil(pageViewport.height);
      this.renderTask = page.render({ canvasContext: temporary.getContext("2d", { alpha: false }), viewport: pageViewport });
      try { await this.renderTask.promise; }
      catch (error) {
        if (error?.name !== "RenderingCancelledException") throw error;
        return;
      }
      const sourceX = slice.x * scale * dpr;
      const sourceY = slice.y * scale * dpr;
      const sourceWidth = slice.width * scale * dpr;
      const sourceHeight = slice.height * scale * dpr;
      context.drawImage(temporary, sourceX, sourceY, sourceWidth, sourceHeight, 0, destinationY, sourceWidth, sourceHeight);
      destinationY += sourceHeight + 10 * scale * dpr;
      temporary.width = 1;
      temporary.height = 1;
      page.cleanup?.();
    }
    if (serial !== this.renderSerial) return;
    this.pageInput.value = String(this.pageNumber);
    this.strokes = await inkDatabase.get(this.inkKey);
    this.redrawInk();

    requestAnimationFrame(() => {
      if (preservePosition) {
        this.viewportElement.scrollLeft = Math.max(0, xRatio * this.viewportElement.scrollWidth - this.viewportElement.clientWidth / 2);
        this.viewportElement.scrollTop = Math.max(0, yRatio * this.viewportElement.scrollHeight - this.viewportElement.clientHeight / 2);
      } else {
        this.viewportElement.scrollTo({ top: 0, left: 0 });
      }
      this.rememberScroll();
    });
  }

  rememberScroll() {
    this.lastScrollTop = this.viewportElement.scrollTop;
    this.lastScrollLeft = this.viewportElement.scrollLeft;
  }

  syncScroll() {
    const top = this.viewportElement.scrollTop;
    const left = this.viewportElement.scrollLeft;
    const deltaTop = top - this.lastScrollTop;
    const deltaLeft = left - this.lastScrollLeft;
    this.lastScrollTop = top;
    this.lastScrollLeft = left;
    if (syncGuard || !$("#syncScroll").checked || !this.other?.document || (!deltaTop && !deltaLeft)) return;
    syncGuard = true;
    this.other.viewportElement.scrollTop += deltaTop;
    this.other.viewportElement.scrollLeft += deltaLeft;
    this.other.rememberScroll();
    requestAnimationFrame(() => { syncGuard = false; });
  }

  bindInkEvents() {
    const touchMetrics = () => {
      const points = [...this.touchPointers.values()].slice(0, 2);
      if (points.length < 2) return null;
      return {
        x: (points[0].x + points[1].x) / 2,
        y: (points[0].y + points[1].y) / 2,
        distance: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y),
      };
    };
    this.inkCanvas.addEventListener("contextmenu", (event) => event.preventDefault());
    this.inkCanvas.addEventListener("pointerdown", (event) => {
      if (currentMode !== "ink" || !this.document) return;
      activePane = this;
      event.preventDefault();
      this.inkCanvas.setPointerCapture(event.pointerId);
      if (event.pointerType === "touch") {
        this.touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (this.touchPointers.size === 1) {
          this.touchStartSnapshot = JSON.parse(JSON.stringify(this.strokes));
        } else {
          this.suppressTouchInk = true;
          this.strokes = this.touchStartSnapshot || this.strokes;
          this.drawing = null;
          this.pointerId = null;
          this.redrawInk();
          this.saveInk();
          const metrics = touchMetrics();
          const bounds = this.stage.getBoundingClientRect();
          this.stage.style.transformOrigin = `${Math.max(0, Math.min(100, ((metrics.x - bounds.left) / bounds.width) * 100))}% ${Math.max(0, Math.min(100, ((metrics.y - bounds.top) / bounds.height) * 100))}%`;
          this.panGesture = {
            startX: metrics.x,
            startY: metrics.y,
            startDistance: Math.max(1, metrics.distance),
            startScrollLeft: this.viewportElement.scrollLeft,
            startScrollTop: this.viewportElement.scrollTop,
            startZoom: this.zoom,
            factor: 1,
          };
          return;
        }
        if (this.suppressTouchInk) return;
      }
      this.pointerId = event.pointerId;
      this.drawingPointerType = event.pointerType;
      if (currentTool === "eraser") {
        this.eraseAt(event);
        return;
      }
      const point = this.eventPoint(event);
      this.drawing = {
        tool: currentTool,
        color: currentColor,
        width: Number($("#strokeWidth").value) / this.stage.clientWidth,
        points: [point],
      };
      this.strokes.push(this.drawing);
      this.redrawInk();
    });
    this.inkCanvas.addEventListener("pointermove", (event) => {
      if (event.pointerType === "touch" && this.touchPointers.has(event.pointerId)) {
        this.touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }
      if (this.panGesture && this.touchPointers.size >= 2) {
        event.preventDefault();
        const metrics = touchMetrics();
        const factor = Math.max(0.45, Math.min(3, metrics.distance / this.panGesture.startDistance));
        this.panGesture.factor = factor;
        this.stage.style.transform = `scale(${factor})`;
        this.viewportElement.scrollLeft = this.panGesture.startScrollLeft - (metrics.x - this.panGesture.startX);
        this.viewportElement.scrollTop = this.panGesture.startScrollTop - (metrics.y - this.panGesture.startY);
        return;
      }
      if (event.pointerId !== this.pointerId) return;
      event.preventDefault();
      if (currentTool === "eraser") {
        this.eraseAt(event);
        return;
      }
      if (!this.drawing) return;
      const events = event.getCoalescedEvents?.() || [event];
      for (const item of events) this.drawing.points.push(this.eventPoint(item));
      this.redrawInk();
    });
    const finish = (event) => {
      if (event.pointerType === "touch") {
        this.touchPointers.delete(event.pointerId);
        if (this.suppressTouchInk) {
          if (this.panGesture) {
            const targetZoom = this.panGesture.startZoom * this.panGesture.factor;
            this.panGesture = null;
            this.stage.style.transform = "";
            this.stage.style.transformOrigin = "";
            setZoom(targetZoom * 100);
          }
          if (this.touchPointers.size === 0) {
            this.suppressTouchInk = false;
            this.touchStartSnapshot = null;
          }
          return;
        }
        this.touchStartSnapshot = null;
      }
      if (event.pointerId !== this.pointerId) return;
      this.pointerId = null;
      this.drawing = null;
      this.drawingPointerType = null;
      this.saveInk();
    };
    this.inkCanvas.addEventListener("pointerup", finish);
    this.inkCanvas.addEventListener("pointercancel", finish);
  }

  eventPoint(event) {
    const bounds = this.inkCanvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
      p: event.pressure > 0 ? event.pressure : 0.5,
    };
  }

  eraseAt(event) {
    const point = this.eventPoint(event);
    const radius = Math.max(12, Number($("#strokeWidth").value) * 1.8) / this.stage.clientWidth;
    const previousLength = this.strokes.length;
    this.strokes = this.strokes.filter((stroke) => !stroke.points.some((item) => Math.hypot(item.x - point.x, item.y - point.y) <= radius));
    if (this.strokes.length !== previousLength) {
      this.redrawInk();
      this.saveInk();
    }
  }

  redrawInk() {
    const context = this.inkCanvas.getContext("2d");
    const dpr = this.inkDpr;
    const width = this.stage.clientWidth;
    const height = this.stage.clientHeight;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.inkCanvas.width, this.inkCanvas.height);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.lineCap = "round";
    context.lineJoin = "round";

    for (const stroke of this.strokes) {
      if (!stroke.points?.length) continue;
      context.strokeStyle = stroke.color;
      context.fillStyle = stroke.color;
      context.globalAlpha = stroke.tool === "highlighter" ? 0.28 : 1;
      context.globalCompositeOperation = stroke.tool === "highlighter" ? "multiply" : "source-over";
      const baseWidth = Math.max(1, stroke.width * width) * (stroke.tool === "highlighter" ? 3.2 : 1);
      if (stroke.points.length === 1) {
        const point = stroke.points[0];
        context.beginPath();
        context.arc(point.x * width, point.y * height, baseWidth / 2, 0, Math.PI * 2);
        context.fill();
        continue;
      }
      for (let index = 1; index < stroke.points.length; index += 1) {
        const before = stroke.points[index - 1];
        const point = stroke.points[index];
        const pressure = stroke.tool === "highlighter" ? 1 : 0.55 + 0.7 * ((before.p + point.p) / 2);
        context.lineWidth = baseWidth * pressure;
        context.beginPath();
        context.moveTo(before.x * width, before.y * height);
        context.lineTo(point.x * width, point.y * height);
        context.stroke();
      }
    }
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
  }

  saveInk() {
    if (!this.document) return;
    clearTimeout(this.saveTimer);
    const key = this.inkKey;
    const snapshot = JSON.parse(JSON.stringify(this.strokes));
    this.saveTimer = setTimeout(() => inkDatabase.put(key, snapshot), 80);
  }

  undo() {
    if (!this.document || !this.strokes.length) return;
    this.strokes.pop();
    this.redrawInk();
    this.saveInk();
  }

  clear() {
    if (!this.document || !this.strokes.length) return;
    this.strokes = [];
    this.redrawInk();
    this.saveInk();
  }
}

const leftPane = new PdfPane("left");
const rightPane = new PdfPane("right");
leftPane.other = rightPane;
rightPane.other = leftPane;
activePane = leftPane;

function updateDetectionStatus() {
  if (!leftPane.document && !rightPane.document) return;
  const leftCount = leftPane.questions.size;
  const rightCount = rightPane.questions.size;
  const leftColumns = leftPane.layoutColumns;
  const rightColumns = rightPane.layoutColumns;
  $("#detectStatus").textContent = `문제 ${leftCount}개(${leftColumns}단) · 해설 ${rightCount}개(${rightColumns}단) 인식`;
}

async function goQuestion(value) {
  const next = Math.max(1, Math.min(25, Math.round(Number(value) || 1)));
  currentQuestion = next;
  $("#questionNumber").value = String(next);
  $("#questionPrev").disabled = next <= 1;
  $("#questionNext").disabled = next >= 25;
  await Promise.all([
    leftPane.document ? leftPane.renderQuestion(next) : Promise.resolve(),
    rightPane.document ? rightPane.renderQuestion(next) : Promise.resolve(),
  ]);
}

function setMode(mode) {
  if (appMode === "compare") mode = "view";
  const changed = currentMode !== mode;
  currentMode = mode;
  document.body.classList.toggle("ink-mode", mode === "ink");
  $("#inkToolbar").classList.toggle("visible", mode === "ink");
  $("#inkToolbar").setAttribute("aria-hidden", String(mode !== "ink"));
  $$(".mode").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  if (changed && appMode === "exam") {
    const renders = [leftPane, rightPane]
      .filter((pane) => pane.document && pane.nativeFrame.classList.contains("hidden"))
      .map((pane) => pane.renderQuestion(pane.currentQuestion, true));
    Promise.all(renders).catch((error) => toast(error.message));
  }
}

function setZoom(percent) {
  const value = Math.max(40, Math.min(300, Math.round(Number(percent) || 100)));
  $("#zoomValue").value = String(value);
  Promise.all([leftPane.setZoom(value / 100), rightPane.setZoom(value / 100)]).catch((error) => toast(error.message));
}

$$(".mode").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
$$(".tool").forEach((button) => button.addEventListener("click", () => {
  currentTool = button.dataset.tool;
  $$(".tool").forEach((item) => item.classList.toggle("active", item === button));
}));
$$(".color").forEach((button) => button.addEventListener("click", () => {
  currentColor = button.dataset.color;
  $$(".color").forEach((item) => item.classList.toggle("active", item === button));
}));
$("#zoomOut").addEventListener("click", () => setZoom(Number($("#zoomValue").value) - 10));
$("#zoomIn").addEventListener("click", () => setZoom(Number($("#zoomValue").value) + 10));
$("#zoomValue").addEventListener("change", (event) => setZoom(event.target.value));
$("#questionPrev").addEventListener("click", () => goQuestion(currentQuestion - 1));
$("#questionNext").addEventListener("click", () => goQuestion(currentQuestion + 1));
$("#questionNumber").addEventListener("change", (event) => goQuestion(event.target.value));
$("#syncScroll").addEventListener("change", () => {
  leftPane.rememberScroll();
  rightPane.rememberScroll();
  if ($("#syncScroll").checked) toast("현재 맞춘 위치부터 함께 이동합니다.");
});
$("#undo").addEventListener("click", () => activePane.undo());
$("#clearInk").addEventListener("click", () => {
  if (activePane.strokes.length && window.confirm("현재 보고 있는 쪽의 이 페이지만 필기를 지울까요?")) activePane.clear();
});

$("#fullscreen").addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else toast("Safari 공유 메뉴에서 ‘홈 화면에 추가’를 선택하면 전체화면으로 사용할 수 있습니다.");
  } catch {
    toast("Safari 공유 메뉴에서 ‘홈 화면에 추가’를 선택해 주세요.");
  }
});

const fileDialog = $("#fileDialog");
const modeDialog = $("#modeDialog");
const rangeDialog = $("#rangeDialog");
const leftFile = $("#leftFile");
const rightFile = $("#rightFile");

function validPdf(file) { return file && (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")); }
function formatFileSize(bytes) {
  if (bytes < 1048576) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / 1048576).toFixed(bytes >= 104857600 ? 0 : 1)}MB`;
}
function updatePicked(side, file) {
  $(`#${side}Picked`).textContent = file ? `${file.name} · ${formatFileSize(file.size)}` : "탭해서 파일 선택도 가능합니다";
  $(`#${side}Drop`).classList.toggle("has-file", Boolean(file));
  $("#loadPdfs").disabled = !(validPdf(leftFile.files[0]) && validPdf(rightFile.files[0]));
  $("#compatPdfs").disabled = $("#loadPdfs").disabled;
}

for (const side of ["left", "right"]) {
  const input = $(`#${side}File`);
  const zone = $(`#${side}Drop`);
  input.addEventListener("change", () => updatePicked(side, input.files[0]));
  zone.addEventListener("dragover", (event) => { event.preventDefault(); zone.classList.add("drag"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("drag");
    const file = event.dataTransfer.files[0];
    if (!validPdf(file)) return toast("PDF 파일만 놓아 주세요.");
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    updatePicked(side, file);
  });
}

function configureAppMode(mode) {
  appMode = mode;
  document.body.classList.toggle("compare-mode", mode === "compare");
  document.body.classList.toggle("exam-mode", mode === "exam");
  setMode("view");
  const compare = mode === "compare";
  $("#leftPaneLabel").textContent = compare ? "원본" : "문제";
  $("#rightPaneLabel").textContent = compare ? "비교본" : "해설";
  $("#leftDropBadge").textContent = compare ? "원본" : "문제";
  $("#rightDropBadge").textContent = compare ? "비교본" : "해설";
  $("#leftDropTitle").textContent = compare ? "원본 PDF 놓기" : "문제 PDF 놓기";
  $("#rightDropTitle").textContent = compare ? "비교 PDF 놓기" : "해설 PDF 놓기";
  $("#fileDialogEyebrow").textContent = compare ? "원본 대조" : "모의고사 풀이";
  $("#fileDialogTitle").textContent = compare ? "두 PDF를 나란히 비교합니다" : "문제와 해설을 나란히 엽니다";
  $("#loadPdfs").textContent = compare ? "두 PDF 대조 시작" : "01~25번 문항 인식해서 열기";
  $("#compatPdfs").textContent = compare ? "PDF가 안 열릴 때 Safari 호환 보기" : "PDF가 안 열릴 때 Safari 호환 보기";
  $("#leftLayout").value = compare ? "1" : "auto";
  $("#rightLayout").value = compare ? "1" : "auto";
  $("#leftPage").readOnly = !compare;
  $("#rightPage").readOnly = !compare;
  $("#detectStatus").textContent = compare ? "연속 원본 대조" : "01~25 탐색";
  modeDialog.close();
  if (!fileDialog.open) fileDialog.showModal();
}

$$('.mode-card').forEach((button) => button.addEventListener("click", () => configureAppMode(button.dataset.appMode)));
$("#changeMode").addEventListener("click", () => {
  if (fileDialog.open) fileDialog.close();
  if (!modeDialog.open) modeDialog.showModal();
});
$("#editRanges").addEventListener("click", () => {
  if (!leftPane.document || !rightPane.document) return toast("먼저 두 PDF를 열어 주세요.");
  showRangeDialog(true);
});
$("#openFiles").addEventListener("click", () => fileDialog.showModal());
$("#compatPdfs").addEventListener("click", () => {
  const problem = leftFile.files[0];
  const solution = rightFile.files[0];
  if (!validPdf(problem) || !validPdf(solution)) return;
  leftPane.showNative(problem);
  rightPane.showNative(solution);
  fileDialog.close();
  $("#detectStatus").textContent = appMode === "compare"
    ? "Safari 호환 보기 · 동시 스크롤은 사용하지 않음"
    : "Safari 호환 보기 · 문항 인식과 필기는 사용하지 않음";
  toast("Safari 내장 PDF 표시기로 열었습니다.");
});
$("#loadPdfs").addEventListener("click", async () => {
  const problem = leftFile.files[0];
  const solution = rightFile.files[0];
  if (!validPdf(problem) || !validPdf(solution)) return;
  $("#busy").classList.remove("hidden");
  try {
    if (appMode === "compare") {
      await leftPane.loadCompare(problem);
      await rightPane.loadCompare(solution);
      $("#detectStatus").textContent = `전체 로딩 완료 · 원본 ${leftPane.pageCount}쪽 · 비교본 ${rightPane.pageCount}쪽`;
    } else {
      await leftPane.load(problem);
      await rightPane.load(solution);
      updateDetectionStatus();
      await goQuestion(1);
    }
    fileDialog.close();
    if (appMode === "compare") {
      if (leftPane.pageCount !== rightPane.pageCount) showRangeDialog();
      else toast("두 PDF를 열었습니다. 스크롤을 끄고 위치를 맞춘 뒤 다시 켤 수 있습니다.");
    } else {
      toast("01~25번 위치를 찾았습니다. 좌상단 버튼으로 문항을 이동할 수 있습니다.");
    }
  } catch (error) {
    console.error(error);
    if (appMode === "compare") {
      $("#detectStatus").textContent = "PDF 전체 로딩 실패";
      toast(error?.message || "PDF를 완전히 읽지 못했습니다. 파일을 다시 선택해 주세요.");
    } else {
      leftPane.showNative(problem);
      rightPane.showNative(solution);
      fileDialog.close();
      $("#detectStatus").textContent = "문항 인식 실패 · Safari 호환 보기로 자동 전환됨";
      toast("문항 인식 모드가 실패해 Safari 내장 PDF 표시기로 열었습니다.");
    }
  } finally {
    $("#busy").classList.add("hidden");
    $("#busyLabel").textContent = "PDF 여는 중…";
  }
});

document.addEventListener("keydown", (event) => {
  if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  if (appMode === "exam" && event.key === "ArrowLeft") goQuestion(currentQuestion - 1);
  if (appMode === "exam" && event.key === "ArrowRight") goQuestion(currentQuestion + 1);
});

let resizeTimer = 0;
window.addEventListener("resize", () => {
  leftPane.rememberScroll();
  rightPane.rememberScroll();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const panes = [leftPane, rightPane].filter((pane) => pane.document && pane.nativeFrame.classList.contains("hidden"));
    const renders = appMode === "compare"
      ? panes.map((pane) => pane.buildCompare(true))
      : panes.map((pane) => pane.renderQuestion(pane.currentQuestion, true));
    Promise.all(renders).catch((error) => console.error(error));
  }, 180);
});

function showRangeDialog(useCurrent = false) {
  const common = Math.min(leftPane.pageCount, rightPane.pageCount);
  for (const [side, pane] of [["left", leftPane], ["right", rightPane]]) {
    $(`#${side}RangeStart`).value = String(useCurrent ? pane.compareRange[0] : 1);
    $(`#${side}RangeStart`).max = String(pane.pageCount);
    $(`#${side}RangeEnd`).value = String(useCurrent ? pane.compareRange[1] : common);
    $(`#${side}RangeEnd`).max = String(pane.pageCount);
  }
  $("#rangeHelp").textContent = `원본 ${leftPane.pageCount}쪽, 비교본 ${rightPane.pageCount}쪽입니다. 같은 수의 페이지를 지정해 주세요.`;
  if (!rangeDialog.open) rangeDialog.showModal();
}

$("#applyRanges").addEventListener("click", async () => {
  const values = ["leftRangeStart", "leftRangeEnd", "rightRangeStart", "rightRangeEnd"].map((id) => Number($(`#${id}`).value));
  const [leftStart, leftEnd, rightStart, rightEnd] = values;
  if (values.some((value) => !Number.isInteger(value)) || leftStart < 1 || rightStart < 1 || leftEnd > leftPane.pageCount || rightEnd > rightPane.pageCount || leftEnd < leftStart || rightEnd < rightStart) {
    return toast("각 문서 안의 올바른 페이지 범위를 입력해 주세요.");
  }
  if (leftEnd - leftStart !== rightEnd - rightStart) return toast("두 범위의 페이지 수를 같게 맞춰 주세요.");
  $("#busy").classList.remove("hidden");
  try {
    await Promise.all([leftPane.setCompareRange(leftStart, leftEnd), rightPane.setCompareRange(rightStart, rightEnd)]);
    rangeDialog.close();
    toast("선택한 범위로 비교합니다.");
  } finally {
    $("#busy").classList.add("hidden");
  }
});

modeDialog.showModal();
