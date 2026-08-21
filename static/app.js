import * as pdfjsLib from "/vendor/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.mjs";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const PDF_OPTIONS = {
  cMapUrl: "/vendor/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/vendor/standard_fonts/",
};

let currentMode = "view";
let currentTool = "pen";
let currentColor = "#172033";
let activePane = null;
let syncGuard = false;
let toastTimer = 0;

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 2600);
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
    this.fingerprint = "";
    this.pageNumber = 1;
    this.zoom = 1;
    this.renderTask = null;
    this.renderSerial = 0;
    this.strokes = [];
    this.drawing = null;
    this.pointerId = null;
    this.lastScrollTop = 0;
    this.lastScrollLeft = 0;
    this.saveTimer = 0;

    this.viewportElement = $(`#${side}Viewport`);
    this.stage = $(`#${side}Stage`);
    this.pdfCanvas = $(`#${side}Pdf`);
    this.inkCanvas = $(`#${side}Ink`);
    this.empty = $(`#${side}Empty`);
    this.nameElement = $(`#${side}Name`);
    this.pageInput = $(`#${side}Page`);
    this.totalElement = $(`#${side}Total`);

    $(`#${side}Prev`).addEventListener("click", () => this.setPage(this.pageNumber - 1));
    $(`#${side}Next`).addEventListener("click", () => this.setPage(this.pageNumber + 1));
    this.pageInput.addEventListener("change", () => this.setPage(Number(this.pageInput.value)));
    this.viewportElement.addEventListener("scroll", () => this.syncScroll());
    this.viewportElement.addEventListener("pointerdown", () => { activePane = this; }, { passive: true });
    this.bindInkEvents();
  }

  get pageCount() { return this.document?.numPages || 0; }
  get inkKey() { return `${this.fingerprint}:${this.pageNumber}`; }

  async load(file) {
    if (!file || (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf")) {
      throw new Error("PDF 파일만 열 수 있습니다.");
    }
    if (this.renderTask) this.renderTask.cancel();
    if (this.document?.cleanup) await this.document.cleanup();

    const buffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer), ...PDF_OPTIONS });
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
    this.stage.classList.remove("hidden");
    await this.render();
  }

  async setPage(value, propagate = true) {
    if (!this.document) return;
    const next = Math.max(1, Math.min(this.pageCount, Math.round(Number(value) || 1)));
    if (next === this.pageNumber) {
      this.pageInput.value = String(next);
      return;
    }
    this.pageNumber = next;
    await this.render();
    if (propagate && $("#syncPages").checked && this.other?.document) {
      await this.other.setPage(Math.min(next, this.other.pageCount), false);
    }
  }

  async setZoom(value) {
    this.zoom = value;
    if (this.document) await this.render(true);
  }

  async render(preservePosition = false) {
    if (!this.document) return;
    const serial = ++this.renderSerial;
    const xRatio = preservePosition && this.viewportElement.scrollWidth > this.viewportElement.clientWidth
      ? (this.viewportElement.scrollLeft + this.viewportElement.clientWidth / 2) / this.viewportElement.scrollWidth : 0.5;
    const yRatio = preservePosition && this.viewportElement.scrollHeight > this.viewportElement.clientHeight
      ? (this.viewportElement.scrollTop + this.viewportElement.clientHeight / 2) / this.viewportElement.scrollHeight : 0;

    if (this.renderTask) {
      try { this.renderTask.cancel(); } catch { /* already complete */ }
    }
    const page = await this.document.getPage(this.pageNumber);
    if (serial !== this.renderSerial) return;
    const viewport = page.getViewport({ scale: this.zoom });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);

    this.stage.style.width = `${width}px`;
    this.stage.style.height = `${height}px`;
    this.pdfCanvas.width = Math.ceil(viewport.width * dpr);
    this.pdfCanvas.height = Math.ceil(viewport.height * dpr);
    this.pdfCanvas.style.width = `${width}px`;
    this.pdfCanvas.style.height = `${height}px`;
    this.inkCanvas.width = Math.ceil(viewport.width * dpr);
    this.inkCanvas.height = Math.ceil(viewport.height * dpr);
    this.inkCanvas.style.width = `${width}px`;
    this.inkCanvas.style.height = `${height}px`;

    const context = this.pdfCanvas.getContext("2d", { alpha: false });
    this.renderTask = page.render({
      canvasContext: context,
      viewport,
      transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0],
    });
    try { await this.renderTask.promise; }
    catch (error) {
      if (error?.name !== "RenderingCancelledException") throw error;
      return;
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
    this.inkCanvas.addEventListener("contextmenu", (event) => event.preventDefault());
    this.inkCanvas.addEventListener("pointerdown", (event) => {
      if (currentMode !== "ink" || !this.document) return;
      activePane = this;
      event.preventDefault();
      this.pointerId = event.pointerId;
      this.inkCanvas.setPointerCapture(event.pointerId);
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
      if (event.pointerId !== this.pointerId) return;
      this.pointerId = null;
      this.drawing = null;
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
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
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

function setMode(mode) {
  currentMode = mode;
  document.body.classList.toggle("ink-mode", mode === "ink");
  $("#inkToolbar").classList.toggle("visible", mode === "ink");
  $("#inkToolbar").setAttribute("aria-hidden", String(mode !== "ink"));
  $$(".mode").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
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
const leftFile = $("#leftFile");
const rightFile = $("#rightFile");

function validPdf(file) { return file && (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")); }
function updatePicked(side, file) {
  $(`#${side}Picked`).textContent = file ? file.name : "탭해서 파일 선택도 가능합니다";
  $(`#${side}Drop`).classList.toggle("has-file", Boolean(file));
  $("#loadPdfs").disabled = !(validPdf(leftFile.files[0]) && validPdf(rightFile.files[0]));
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

$("#openFiles").addEventListener("click", () => fileDialog.showModal());
$("#loadPdfs").addEventListener("click", async () => {
  const problem = leftFile.files[0];
  const solution = rightFile.files[0];
  if (!validPdf(problem) || !validPdf(solution)) return;
  $("#busy").classList.remove("hidden");
  try {
    await Promise.all([leftPane.load(problem), rightPane.load(solution)]);
    fileDialog.close();
    toast("PDF를 열었습니다. 필기는 이 브라우저에 자동 저장됩니다.");
  } catch (error) {
    console.error(error);
    toast(`PDF를 열지 못했습니다: ${error.message || "파일을 확인해 주세요."}`);
  } finally {
    $("#busy").classList.add("hidden");
  }
});

document.addEventListener("keydown", (event) => {
  if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  if (event.key === "ArrowLeft") activePane.setPage(activePane.pageNumber - 1);
  if (event.key === "ArrowRight") activePane.setPage(activePane.pageNumber + 1);
});

window.addEventListener("resize", () => {
  leftPane.rememberScroll();
  rightPane.rememberScroll();
});

fileDialog.showModal();
