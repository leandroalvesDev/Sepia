'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import JSZip from 'jszip';
import ePub, { Book, Rendition } from 'epubjs';
import { useDropzone } from 'react-dropzone';
import { motion, AnimatePresence, useMotionValue } from 'framer-motion';
import { 
  BookOpen, Moon, Sun, Coffee, 
  ChevronLeft, ChevronRight, X, Maximize, 
  Minimize, Loader2, ZoomIn, ZoomOut, Palette, Check, ArrowDown, Search,
  Highlighter, Eraser, CupSoda, ListTree, ScrollText, ChevronDown, FileDown, Volume2
} from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { idbPut, idbGet, idbDelete, FILE_STORE, COVER_STORE } from '../lib/db';

type Theme = 'light' | 'dark' | 'sepia' | 'cafe';
type FileType = 'image' | 'pdf' | 'epub' | null;
type SearchStatus = 'idle' | 'searching' | 'done' | 'unsupported' | 'error';
type HighlightKey = 'yellow' | 'green' | 'blue' | 'pink';

type SearchResult = {
  id: string;
  label: string;
  context: string;
  pdfPageIndex?: number;
  cfi?: string;
};

type HighlightEntry = {
  cfi: string;
  color: HighlightKey;
};

const HIGHLIGHT_COLORS: Record<HighlightKey, { label: string; fill: string; opacity: number; swatch: string }> = {
  yellow: { label: 'Amarelo', fill: '#FFD54A', opacity: 0.5, swatch: '#FFD54A' },
  green: { label: 'Verde', fill: '#7BC96F', opacity: 0.5, swatch: '#7BC96F' },
  blue: { label: 'Azul', fill: '#6FC8E8', opacity: 0.5, swatch: '#6FC8E8' },
  pink: { label: 'Rosa', fill: '#F48FB1', opacity: 0.5, swatch: '#F48FB1' },
};

const FONT_MIN = 12;
const FONT_MAX = 32;
const FONT_DEFAULT = 16;
const SEARCH_RESULT_LIMIT = 500;
const HL_LOCAL_PREFIX = 'reader-highlights';
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;

const THEME_STYLES: Record<Theme, string> = {
  light: 'bg-gray-50 text-gray-900',
  dark: 'bg-black text-gray-300',
  sepia: 'bg-[#F4ECD8] text-[#432c21]',
  // Mesma identidade da landing page: marrom-escuro + dourado + bege.
  cafe: 'bg-[#14110d] text-[#e8ddc8]'
};

// Overlay (topbar/barra flutuante) que segue o tema do app, em vez de
// depender do dark: do media query do sistema (que nunca casa com o tema).
const BAR_STYLES: Record<Theme, { wrap: string; btn: string; text: string }> = {
  light: {
    wrap: 'bg-white/85 border-black/10',
    btn: 'hover:bg-black/5 text-gray-800',
    text: 'text-gray-800',
  },
  dark: {
    wrap: 'bg-[#0d0d0d]/85 border-white/10',
    btn: 'hover:bg-white/10 text-gray-200',
    text: 'text-gray-200',
  },
  sepia: {
    wrap: 'bg-[#F4ECD8]/90 border-[#432c21]/10',
    btn: 'hover:bg-[#432c21]/10 text-[#432c21]',
    text: 'text-[#432c21]',
  },
  cafe: {
    wrap: 'bg-[#14110d]/85 border-[#3a3226]/60',
    btn: 'hover:bg-[#e8a766]/15 text-[#e8ddc8]',
    text: 'text-[#e8ddc8]',
  },
};

const SPINNER_STYLES: Record<Theme, string> = {
  light: 'text-gray-500',
  dark: 'text-gray-400',
  sepia: 'text-[#a0602d]',
  cafe: 'text-[#e8a766]',
};

// Transição de folhear estilo Kindle (leve: apenas translateX + opacity, GPU-friendly)
const pageFlipVariants = {
  enter: (direction: number) => ({
    x: direction > 0 ? '6%' : '-6%',
    opacity: 0,
  }),
  center: {
    x: 0,
    opacity: 1,
    transition: {
      x: { type: "spring", stiffness: 300, damping: 40 },
      opacity: { duration: 0.2 }
    }
  },
  exit: (direction: number) => ({
    x: direction > 0 ? '-6%' : '6%',
    opacity: 0,
    transition: {
      x: { type: "spring", stiffness: 300, damping: 40 },
      opacity: { duration: 0.2 }
    }
  })
};

export default function Reader() {
  const [pages, setPages] = useState<string[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [direction, setDirection] = useState(0);
  const [fileName, setFileName] = useState('');
  const [fileType, setFileType] = useState<FileType>(null);
  const [zoom, setZoom] = useState(1);
  const panX = useMotionValue(0);
  const panY = useMotionValue(0);
  const pinchRef = useRef<{ dist: number; scale: number } | null>(null);
  const lastTapRef = useRef(0);
  const wheelTurnAtRef = useRef(0);

  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

  // Mantém a página dentro das próprias bordas no modo zoom (pan limitado).
  const clampPan = useCallback((x: number, y: number) => {
    const container = viewerRef.current;
    const img = imgRef.current;
    if (!container || !img) return { x, y };
    const W = container.clientWidth;
    const H = container.clientHeight;
    const overflowX = Math.max(0, zoomRef.current * img.clientWidth - W);
    const overflowY = Math.max(0, zoomRef.current * img.clientHeight - H);
    return {
      x: clamp(x, -overflowX / 2, overflowX / 2),
      y: clamp(y, -overflowY / 2, overflowY / 2),
    };
  }, []);

  // Aplica o zoom. Quando `anchor` é fornecido (rodinha do mouse), ajusta o
  // pan para manter sob o cursor o mesmo ponto da página que havia antes.
  const applyZoom = useCallback((next: number, anchor?: { x: number; y: number }) => {
    const z = clamp(next, ZOOM_MIN, ZOOM_MAX);
    setZoom(z);
    zoomRef.current = z;
    if (z === ZOOM_MIN) {
      panX.set(0);
      panY.set(0);
      return;
    }
    const container = viewerRef.current;
    const img = imgRef.current;
    if (anchor && container && img) {
      const p = clampPan(anchor.x, anchor.y);
      panX.set(p.x);
      panY.set(p.y);
    }
  }, [panX, panY, clampPan]);

  // Limites de translação (pan) para o modo zoom: impede arrastar a página
  // além das suas próprias bordas, evitando espaço vazio na tela.
  const getPanConstraints = useCallback(() => {
    if (zoom <= 1) return { top: 0, bottom: 0, left: 0, right: 0 };
    const container = viewerRef.current;
    const img = imgRef.current;
    if (!container || !img) return { top: 0, bottom: 0, left: 0, right: 0 };
    const W = container.clientWidth;
    const H = container.clientHeight;
    const fitW = img.clientWidth;   // tamanho do layout (ignora transform)
    const fitH = img.clientHeight;
    const overflowX = Math.max(0, zoom * fitW - W);
    const overflowY = Math.max(0, zoom * fitH - H);
    return {
      left: -overflowX / 2,
      right: overflowX / 2,
      top: -overflowY / 2,
      bottom: overflowY / 2,
    };
  }, [zoom]);
  
  const [isLoading, setIsLoading] = useState(false);
  const [isUiVisible, setIsUiVisible] = useState(true);
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'sepia';
    const saved = localStorage.getItem('reader-theme') as Theme | null;
    // 'landing' era o nome antigo do tema café — migra automaticamente.
    if ((saved as string) === 'landing') return 'cafe';
    return saved === 'light' || saved === 'dark' || saved === 'sepia' || saved === 'cafe' ? saved : 'sepia';
  });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showThemeMenu, setShowThemeMenu] = useState(false);
  const [pdfReady, setPdfReady] = useState(false);

  // ----- Ir para página -----
  const [pageInput, setPageInput] = useState('');
  const [epubPageTotal, setEpubPageTotal] = useState<number | null>(null);

  // ----- Sumário (TOC) do EPUB -----
  const [toc, setToc] = useState<Array<{ label: string; href: string; cfi?: string; subitems?: boolean }>>([]);
  const [tocOpen, setTocOpen] = useState(false);
  const tocRef = useRef<Array<{ label: string; href: string; cfi?: string; subitems?: boolean }>>([]);

  // ----- Progresso de leitura do EPUB (relocated) -----
  const [epubProgress, setEpubProgress] = useState(0);
  const [epubTotalViaProgress, setEpubTotal] = useState(0);

  // ----- Fluxo de leitura do EPUB: paginado (página única) ou rolando (scroll contínuo) -----
  const [epubFlow, setEpubFlow] = useState<'paginated' | 'scrolled'>(() => {
    if (typeof window === 'undefined') return 'paginated';
    try {
      const s = localStorage.getItem('reader-epub-flow');
      return s === 'scrolled' ? 'scrolled' : 'paginated';
    } catch { return 'paginated'; }
  });
  const epubFlowRef = useRef(epubFlow);
  epubFlowRef.current = epubFlow;
  const currentFileRef = useRef<File | null>(null);

  // ----- Leitura em voz alta (TTS, local via Web Speech API) -----
  const [isSpeaking, setIsSpeaking] = useState(false);
  const speakingRef = useRef(false);

  // ----- Busca de texto (Ctrl+F) -----
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchStatus, setSearchStatus] = useState<SearchStatus>('idle');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // ----- Tamanho de fonte (EPUB) -----
  const [fontSize, setFontSize] = useState(() => {
    if (typeof window === 'undefined') return FONT_DEFAULT;
    const saved = Number(localStorage.getItem('reader-font-size'));
    return isFinite(saved) && saved >= FONT_MIN && saved <= FONT_MAX ? saved : FONT_DEFAULT;
  });

  // ----- Grifar texto (EPUB) -----
  const [highlights, setHighlights] = useState<HighlightEntry[]>([]);
  const [hlPopover, setHlPopover] = useState<{ x: number; y: number; cfi: string } | null>(null);

  // ----- Feedback discreto (toast) -----
  const [flashMsg, setFlashMsg] = useState<string | null>(null);

  // ----- Pix & Biblioteca -----
  const PIX_KEY = '8e408492-8ef8-45b9-beaa-020d08e066ae';
  const [pixCopied, setPixCopied] = useState(false);
  type LibEntry = { name: string; index: number; total: number; epub: boolean; updated: number; cover?: boolean };
  const [library, setLibrary] = useState<LibEntry[]>([]);
  const [coverUrls, setCoverUrls] = useState<Record<string, string>>({});

  const copyPix = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(PIX_KEY);
      setPixCopied(true);
      setTimeout(() => setPixCopied(false), 2000);
    } catch { /* clipboard indisponível */ }
  }, []);

  const syncLibrary = useCallback(() => {
    try {
      const raw = localStorage.getItem('reader-library');
      setLibrary(raw ? JSON.parse(raw) : []);
    } catch {
      setLibrary([]);
    }
  }, []);

  const upsertLibrary = useCallback((entry: LibEntry) => {
    try {
      const raw = localStorage.getItem('reader-library');
      const list: LibEntry[] = raw ? JSON.parse(raw) : [];
      const idx = list.findIndex(e => e.name === entry.name);
      if (idx >= 0) list[idx] = entry; else list.push(entry);
      list.sort((a, b) => b.updated - a.updated);
      localStorage.setItem('reader-library', JSON.stringify(list));
      setLibrary(list);
      window.dispatchEvent(new Event('reader-library-changed'));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    syncLibrary();
    const handler = () => syncLibrary();
    window.addEventListener('reader-library-changed', handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener('reader-library-changed', handler);
      window.removeEventListener('storage', handler);
    };
  }, [syncLibrary]);

  // Carrega as miniaturas (capas) da biblioteca a partir do IndexedDB.
  useEffect(() => {
    let alive = true;
    const urls: Record<string, string> = {};
    (async () => {
      for (const entry of library) {
        if (!entry.cover) continue;
        try {
          const blob = await idbGet(COVER_STORE, entry.name);
          if (blob && alive) urls[entry.name] = URL.createObjectURL(blob);
        } catch { /* ignore */ }
      }
      if (alive) setCoverUrls(urls);
    })();
    return () => {
      alive = false;
      Object.values(urls).forEach(u => URL.revokeObjectURL(u));
    };
  }, [library]);

  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const didDragRef = useRef(false);
  const zoomRef = useRef(1);
  const renderTaskRef = useRef<any>(null);
  const loadingPagesRef = useRef<Set<number>>(new Set());
  const containerReadyRef = useRef(false);
  const containerSizeRef = useRef<{ w: number; h: number } | null>(null);
  const renderAbortRef = useRef(false);
  const hasCoverRef = useRef(false);
  const cbzRef = useRef<{ zip: JSZip | null; images: string[] }>({ zip: null, images: [] });
  
  const pagesRef = useRef<string[]>([]);
  useEffect(() => { pagesRef.current = pages; }, [pages]);
  
  const searchOpenRef = useRef(false);
  useEffect(() => { searchOpenRef.current = searchOpen; }, [searchOpen]);
  
  const currentIndexRef = useRef(0);
  useEffect(() => { currentIndexRef.current = currentIndex; }, [currentIndex]);
  
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const searchNonceRef = useRef(0);
  const pdfTextCacheRef = useRef<string[]>([]);
  const highlightsRef = useRef<HighlightEntry[]>([]);
  const hlPopoverRef = useRef<{ x: number; y: number; cfi: string } | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightsKeyRef = useRef('');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      (async () => {
        const pdfjs = await import('pdfjs-dist');
        // Worker servido localmente (public/pdf.worker.min.mjs) — 100% offline,
        // sem depender de CDN externo.
        pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
      })();
    }
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // Mede o contêiner real assim que ele é montado. Isso garante que a
  // primeira página do PDF tenha dimensões corretas (evita canvas zerado
  // que causa "loading infinito" no primeiro carregamento).
  useEffect(() => {
    if (fileType !== 'pdf') return;
    const measure = () => {
      if (viewerRef.current && viewerRef.current.clientWidth > 0 && viewerRef.current.clientHeight > 0) {
        containerReadyRef.current = true;
        containerSizeRef.current = {
          w: viewerRef.current.clientWidth,
          h: viewerRef.current.clientHeight,
        };
      }
    };
    measure();
    // Re-mede após o layout estabilizar (fontes, mídia, etc.)
    const t = setTimeout(measure, 100);
    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => { containerReadyRef.current = false; measure(); })
      : null;
    if (ro && viewerRef.current) ro.observe(viewerRef.current);
    return () => {
      clearTimeout(t);
      ro?.disconnect();
    };
  }, [fileType]);

  useEffect(() => {
    if (renditionRef.current && fileType === 'epub') {
      renditionRef.current.themes.select(theme);
    }
  }, [theme, fileType]);

  useEffect(() => {
    try { localStorage.setItem('reader-font-size', String(fontSize)); } catch { /* ignore */ }
    if (renditionRef.current && fileType === 'epub') {
      renditionRef.current.themes.fontSize(fontSize + 'px');
    }
  }, [fontSize, fileType]);

  useEffect(() => {
    try { localStorage.setItem('reader-theme', theme); } catch { /* ignore */ }
  }, [theme]);

  const closeFile = useCallback(() => {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    speakingRef.current = false;
    setIsSpeaking(false);
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
      renderTaskRef.current = null;
    }
    if (bookRef.current) {
      bookRef.current.destroy();
      bookRef.current = null;
    }
    if (renditionRef.current) {
      renditionRef.current.destroy?.();
      renditionRef.current = null;
    }
    pagesRef.current.forEach(url => {
      if (url && typeof url === 'string' && url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
      }
    });

    pdfDocRef.current = null;
    cbzRef.current = { zip: null, images: [] };
    loadingPagesRef.current.clear();
    renderAbortRef.current = false;
    containerReadyRef.current = false;
    containerSizeRef.current = null;
    setPdfReady(false);
    setPages([]);
    setCurrentIndex(0);
    setDirection(0);
    setFileType(null);
    setFileName('');
    setIsUiVisible(true);

    // Limpa estado das novas funcionalidades
    searchNonceRef.current += 1;
    pdfTextCacheRef.current = [];
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);
    setSearchStatus('idle');
    setPageInput('');
    setEpubPageTotal(null);
    setHighlights([]);
    highlightsRef.current = [];
    setHlPopover(null);
    hlPopoverRef.current = null;
    highlightsKeyRef.current = '';
  }, []);

  // ----- Helpers utilitários -----
  const escapeRegExp = useCallback((value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), []);

  const showFlash = useCallback((msg: string) => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setFlashMsg(msg);
    flashTimerRef.current = setTimeout(() => setFlashMsg(null), 2400);
  }, []);

  const loadHighlights = useCallback((name: string): HighlightEntry[] => {
    try {
      const raw = localStorage.getItem(`${HL_LOCAL_PREFIX}-${name}`);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((h): h is HighlightEntry =>
        !!h && typeof h.cfi === 'string' && !!HIGHLIGHT_COLORS[h.color as HighlightKey]
      );
    } catch {
      return [];
    }
  }, []);

  const saveHighlights = useCallback((name: string, list: HighlightEntry[]) => {
    try {
      localStorage.setItem(`${HL_LOCAL_PREFIX}-${name}`, JSON.stringify(list));
    } catch { /* quota/privado indisponível */ }
  }, []);

  // Fragmenta o texto extraído de uma página de PDF em uma string pesquisável.
  const flattenPdfText = useCallback((items: Array<{ str?: string }>) => {
    return items
      .map(it => (it && typeof it.str === 'string' ? it.str : ''))
      .join(' ')
      .replace(/[\t\u00a0\u2000-\u200a\u3000]+/g, ' ')
      .replace(/[ ]{2,}/g, ' ');
  }, []);

  const processCBZ = async (file: File) => {
    setFileType('image');
    const zip = new JSZip();
    const contents = await zip.loadAsync(file, {
      checkCRC32: false,
      optimizedBinaryString: true,
      createFolders: false,
    });
    const images = Object.keys(contents.files)
      .filter(name => name.match(/\.(jpg|jpeg|png|webp)$/i))
      .sort(new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare);

    cbzRef.current = { zip: contents, images };
    // Só desconhece a primeira página; o resto é carregado sob demanda.
    return new Array(images.length).fill('');
  };

  // Renderização sob demanda de CBZ: descompacta só a página alvo e cacheia.
  const renderCbzPage = useCallback(async (targetIndex: number) => {
    const { zip, images } = cbzRef.current;
    if (!zip || targetIndex < 0 || targetIndex >= images.length) return;
    if (pagesRef.current[targetIndex]) return;
    if (loadingPagesRef.current.has(targetIndex)) return;
    loadingPagesRef.current.add(targetIndex);

    try {
      const blob = await zip.files[images[targetIndex]].async('blob');
      if (renderAbortRef.current) return;
      const url = URL.createObjectURL(blob);
      setPages(prev => {
        if (prev[targetIndex]) return prev;
        const newPages = [...prev];
        newPages[targetIndex] = url;
        return newPages;
      });
    } catch (error) {
      console.error('Erro CBZ página', targetIndex + 1, error);
    } finally {
      loadingPagesRef.current.delete(targetIndex);
    }
  }, []);

  const processPDF = async (file: File) => {
    setFileType('pdf');
    const pdfjs = await import('pdfjs-dist');
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
    pdfDocRef.current = pdf;
    return new Array(pdf.numPages).fill('');
  };

  const processEpub = async (file: File) => {
    setFileType('epub');
    const arrayBuffer = await file.arrayBuffer();
    const book = ePub(arrayBuffer);
    bookRef.current = book;

    const rendition = book.renderTo("epub-viewer", {
      width: "100%",
      height: "100%",
      spread: "none",
      manager: "continuous",
      flow: epubFlowRef.current,
    });
    
    renditionRef.current = rendition;

    rendition.themes.register("light", { "body": { "background": "transparent", "color": "#111827" }});
    rendition.themes.register("dark", { "body": { "background": "transparent", "color": "#d1d5db" }});
    rendition.themes.register("sepia", { "body": { "background": "transparent", "color": "#432c21" }});
    rendition.themes.register("cafe", { "body": { "background": "transparent", "color": "#e8ddc8" }});
    rendition.themes.select(theme);
    rendition.themes.fontSize(fontSize + 'px');

    const progressKey = `reader-progress-${file.name}`;
    const savedCfi = localStorage.getItem(progressKey);
    await rendition.display(savedCfi || undefined);
    rendition.on("relocated", (location: any) => {
      if (location?.start?.cfi) {
        localStorage.setItem(progressKey, location.start.cfi);
      }
      if (bookRef.current?.locations?.length?.()) {
        const total = bookRef.current.locations.length();
        let percent = 0;
        try { percent = bookRef.current.locations.percentageFromCfi(location?.start?.cfi) * 100; } catch { /* */ }
        if (!Number.isNaN(percent)) setEpubProgress(Math.round(clamp(percent, 0, 100)));
        setEpubTotal(total);
      }
    });

    // Clique vira página/alterna UI, mas nunca durante seleção de texto/grifo.
    rendition.on("click", () => {
      if (hlPopoverRef.current) return;
      try {
        const views = (renditionRef.current?.views?.() || []) as Array<{ contents?: { window?: Window } }>;
        for (const view of views) {
          const sel = view?.contents?.window?.getSelection?.();
          if (sel && sel.rangeCount && !sel.getRangeAt(0).collapsed) return;
        }
      } catch { /* ignore */ }
      setIsUiVisible(prev => !prev);
    });

    // Texto selecionado → abre o popover de grifos.
    rendition.on("selected", (cfiRange: string, contents: any) => {
      if (!cfiRange || !contents) return;
      try {
        const sel = contents?.window?.getSelection?.();
        let x = Math.round(window.innerWidth / 2);
        let y = 110;
        if (sel && sel.rangeCount && !sel.getRangeAt(0).collapsed) {
          const rect = sel.getRangeAt(0).getBoundingClientRect();
          const frame = contents?.window?.frameElement as HTMLElement | null;
          if (frame) {
            const fr = frame.getBoundingClientRect();
            x = fr.left + rect.left + rect.width / 2;
            y = fr.top + rect.top;
          }
          x = clamp(Math.round(x), 90, Math.round(window.innerWidth) - 90);
          y = clamp(Math.round(y), 64, Math.max(64, Math.round(window.innerHeight) - 180));
          const next = { x, y, cfi: cfiRange };
          hlPopoverRef.current = next;
          setHlPopover(next);
        }
      } catch { /* ignore */ }
    });

    // Tocar em um grifo existente também abre o popover (para remover).
    rendition.on("markClicked", (cfiRange: string, _data: any, contents: any) => {
      if (!cfiRange) return;
      try {
        const contentsTarget: any = contents || rendition.getContents();
        const range = contentsTarget?.range?.(cfiRange);
        const rect = range?.getBoundingClientRect?.();
        const frame = contentsTarget?.window?.frameElement as HTMLElement | null;
        let x = Math.round(window.innerWidth / 2);
        let y = 110;
        if (rect && frame) {
          const fr = frame.getBoundingClientRect();
          x = fr.left + rect.left + rect.width / 2;
          y = fr.top + rect.top;
        }
        x = clamp(Math.round(x), 90, Math.round(window.innerWidth) - 90);
        y = clamp(Math.round(y), 64, Math.max(64, Math.round(window.innerHeight) - 180));
        const next = { x, y, cfi: cfiRange };
        hlPopoverRef.current = next;
        setHlPopover(next);
      } catch { /* ignore */ }
    });

    // Restaura grifos salvos deste arquivo.
    highlightsKeyRef.current = `${HL_LOCAL_PREFIX}-${file.name}`;
    const savedHls = loadHighlights(file.name);
    savedHls.forEach(h => {
      try {
        rendition.annotations.add(
          'highlight',
          h.cfi,
          { color: h.color },
          undefined,
          'sepia-hl',
          { fill: HIGHLIGHT_COLORS[h.color].fill, 'fill-opacity': HIGHLIGHT_COLORS[h.color].opacity } as any,
        );
      } catch { /* cfi órfão */ }
    });
    highlightsRef.current = savedHls;
    setHighlights(savedHls);

    // Gera índices de "páginas" no fundo (para o salto de página em EPUB)
    // e monta o sumário (TOC) a partir da navegação do livro.
    void (async () => {
      try {
        await book.ready;
        const nav = book.navigation?.toc || [];
        const flat = (items: any[], depth: number): Array<{ label: string; cfi?: string; href: string; depth: number }> => {
          return (items || []).flatMap((n: any) => {
            const label = typeof n.label === 'string' ? n.label : '';
            const href = typeof n.href === 'string' ? n.href : '';
            const cfi = n.cfi ?? n.hrefCfi ?? undefined;
            const self = label ? [{ label, cfi, href, depth }] : [];
            return [...self, ...flat(n.subitems, depth + 1)];
          });
        };
        const flatToc = flat(nav, 0);
        flatToc.forEach(x => {
          tocRef.current.push({ label: x.label, href: x.href, cfi: x.cfi, subitems: x.depth > 0 });
        });
        setToc([...tocRef.current]);
        await book.locations.generate(1500);
        if (bookRef.current === book) setEpubPageTotal(book.locations.length());
      } catch { /* não determinístico p/ esse livro */ }
    })();

    upsertLibrary({ name: file.name, index: 0, total: 0, epub: true, updated: Date.now() });
    
    return [];
  };

  // Extrai uma miniatura (capa) de PDFs e CBZs. Retorna null se indisponível.
  const extractCover = useCallback(async (file: File, extension: string): Promise<Blob | null> => {
    try {
      if (extension === 'pdf') {
        const pdfjs = await import('pdfjs-dist');
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
        const page = await pdf.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const scale = 220 / Math.min(base.width, 400);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', 0.8));
        pdf.cleanup();
        return blob;
      }
      if (extension === 'cbz' || extension === 'zip') {
        const zip = new JSZip();
        const contents = await zip.loadAsync(file);
        const imageFiles = Object.keys(contents.files)
          .filter(name => name.match(/\.(jpg|jpeg|png|webp)$/i))
          .sort(new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare);
        if (imageFiles.length === 0) return null;
        const blob = await contents.files[imageFiles[0]].async('blob');
        return blob;
      }
      return null;
    } catch {
      return null;
    }
  }, []);

  // Faz o upsert do registro da biblioteca com o total real de páginas.
  const updateLibEntry = useCallback((name: string, index: number, total: number, epub: boolean, cover: boolean) => {
    upsertLibrary({ name, index, total, epub, updated: Date.now(), cover });
  }, [upsertLibrary]);

  // Renderização sob demanda: renderiza a página alvo com escala que cabe na tela
  // (canvas enxuto = primeira página instantânea) e faz prefetch das vizinhas.
  const renderPdfPage = useCallback(async (targetIndex: number, qualityScale?: number, force?: boolean) => {
    const pdf = pdfDocRef.current;
    if (!pdf || targetIndex < 0 || targetIndex >= pdf.numPages) return;
    if (!force && pagesRef.current[targetIndex]) return;
    if (loadingPagesRef.current.has(targetIndex)) return;

    loadingPagesRef.current.add(targetIndex);

    try {
      const page = await pdf.getPage(targetIndex + 1);

      const base = page.getViewport({ scale: 1 });
      const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
      // Mede o contêiner real (viewerRef) em vez de window, para nunca
      // renderizar com dimensões zeradas quando o DOM ainda não montou.
      const size = containerSizeRef.current
        || (viewerRef.current
          ? { w: viewerRef.current.clientWidth, h: viewerRef.current.clientHeight }
          : null);
      const containerW = (size && size.w > 0) ? size.w : (typeof window !== 'undefined' ? window.innerWidth : 400);
      const containerH = (size && size.h > 0) ? size.h : (typeof window !== 'undefined' ? window.innerHeight : 800);
      // Escala responsiva: cabe na tela inteira preservando a proporção.
      // Em telas pequenas (celular) o fator limitante é a largura; no desktop, a altura.
      const scaleByWidth = (containerW / base.width) * dpr;
      const scaleByHeight = (containerH / base.height) * dpr;
      const fitScale = Math.min(scaleByWidth, scaleByHeight);
      // Com zoom, multiplica a escala de encaixe (limite 8x p/ não explodir memória).
      const renderScale = Math.min(8, Math.max(1, fitScale * (qualityScale ?? 1)));
      const viewport = page.getViewport({ scale: renderScale });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');

      if (context) {
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        const renderContext = { canvasContext: context, viewport, canvas };
        const renderTask = page.render(renderContext);

        // Só rastreia a tarefa da página atual (para cancelamento em trocas rápidas)
        if (targetIndex === currentIndexRef.current) {
          renderTaskRef.current = renderTask;
        }

        await renderTask.promise;

        if (renderAbortRef.current) return;

        const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', 0.85));

        if (blob && !renderAbortRef.current) {
          const url = URL.createObjectURL(blob);
          setPages(prev => {
            if (!force && prev[targetIndex]) return prev;
            const newPages = [...prev];
            if (force && newPages[targetIndex]) URL.revokeObjectURL(newPages[targetIndex]);
            newPages[targetIndex] = url;
            return newPages;
          });
        }
      }
    } catch (error: any) {
      if (error.name !== 'RenderingCancelledException') {
        console.error(`Erro PDF página ${targetIndex + 1}:`, error);
      }
    } finally {
      loadingPagesRef.current.delete(targetIndex);
      if (renderTaskRef.current) renderTaskRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!pdfDocRef.current || fileType !== 'pdf') return;

    let cancelled = false;

    // Garante que o contêiner existe e esteja dimensionado antes de
    // renderizar a primeira página. Sem isso, o canvas é gerado com
    // dimensões zeradas e a página 0 nunca é preenchida -> loading infinito.
    const renderCurrent = () => {
      if (cancelled) return;
      if (pdfDocRef.current && !renderAbortRef.current) {
        renderPdfPage(currentIndex);
        const total = pdfDocRef.current.numPages;
        if (currentIndex + 1 < total) {
          renderPdfPage(currentIndex + 1);
        } else if (currentIndex - 1 >= 0) {
          renderPdfPage(currentIndex - 1);
        }
      }
    };

    if (containerReadyRef.current && containerSizeRef.current) {
      renderCurrent();
    } else {
      // O contêiner ainda não está montado/dimensionado: espera o próximo
      // frame de layout (RAF) e re-checa. Se não estiver pronto após alguns
      // frames, faz fallback com as dimensões da janela (nunca fica travado).
      const tryUntilReady = () => {
        let attempts = 0;
        const check = () => {
          if (cancelled) return;
          attempts += 1;
          if (viewerRef.current && viewerRef.current.clientWidth > 0 && viewerRef.current.clientHeight > 0) {
            containerReadyRef.current = true;
            containerSizeRef.current = {
              w: viewerRef.current.clientWidth,
              h: viewerRef.current.clientHeight,
            };
            renderCurrent();
            return;
          }
          if (attempts > 10) {
            // Fallback: nunca deixa o carregamento preso. Usa o tamanho da
            // janela como referência aproximada e força a renderização.
            containerReadyRef.current = true;
            containerSizeRef.current = {
              w: typeof window !== 'undefined' ? window.innerWidth : 800,
              h: typeof window !== 'undefined' ? window.innerHeight : 600,
            };
            renderCurrent();
            return;
          }
          requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      };
      tryUntilReady();
    }

    return () => { cancelled = true; };
  }, [currentIndex, fileType, renderPdfPage, pdfReady]);

  // Enquanto houver zoom no PDF, re-renderiza a página atual numa resolução
  // maior (origem multiplicada por zoom), para o texto não ficar borrado.
  useEffect(() => {
    if (fileType !== 'pdf' || !pdfDocRef.current) return;
    if (zoom <= ZOOM_MIN + 0.02) return;
    const t = setTimeout(() => {
      if (renderAbortRef.current || !pdfDocRef.current) return;
      void renderPdfPage(currentIndex, zoom, true);
    }, 240);
    return () => clearTimeout(t);
  }, [zoom, fileType, currentIndex, renderPdfPage]);

  // Renderização sob demanda de CBZ: página atual + vizinhas conforme navega.
  useEffect(() => {
    if (fileType !== 'image' || !cbzRef.current.images.length) return;
    renderCbzPage(currentIndex);
    // prefetch da próxima e da anterior para folhear sem esperar
    if (currentIndex + 1 < cbzRef.current.images.length) renderCbzPage(currentIndex + 1);
    if (currentIndex - 1 >= 0) renderCbzPage(currentIndex - 1);
  }, [currentIndex, fileType, pdfReady, renderCbzPage]);

  // Abre e processa um arquivo (do drop ou da biblioteca).
  const loadBook = useCallback(async (file: File, fromLibrary: boolean) => {
    setIsLoading(true);
    setFileName(file.name);
    currentFileRef.current = file;

    try {
      let initialPages: string[] = [];
      const extension = file.name.split('.').pop()?.toLowerCase();

      if (extension === 'pdf') {
        initialPages = await processPDF(file);
      } else if (extension === 'epub') {
        initialPages = await processEpub(file);
      } else {
        initialPages = await processCBZ(file);
      }

      setPages(initialPages);

      if (extension !== 'epub') {
        const savedPage = localStorage.getItem(`reader-progress-${file.name}`);
        setCurrentIndex(savedPage && Number(savedPage) < initialPages.length ? Number(savedPage) : 0);
      }

      setIsUiVisible(false);
      setPdfReady(true);

      if (!fromLibrary) {
        // Persiste arquivo + capa no IndexedDB para reabertura futura.
        hasCoverRef.current = false;
        const total = extension === 'epub' ? 0 : initialPages.length;
        void (async () => {
          try { await idbPut(FILE_STORE, file.name, file); } catch { /* ignore */ }
          const coverBlob = await extractCover(file, extension);
          if (coverBlob) {
            try { await idbPut(COVER_STORE, file.name, coverBlob); } catch { /* ignore */ }
            hasCoverRef.current = true;
          }
          upsertLibrary({ name: file.name, index: 0, total, epub: extension === 'epub', updated: Date.now(), cover: !!coverBlob });
        })();
      }
    } catch (error) {
      console.error("Erro:", error);
      alert("Formato inválido ou arquivo corrompido.");
      closeFile();
    } finally {
      setIsLoading(false);
    }
  }, [processPDF, processEpub, processCBZ, closeFile, extractCover, upsertLibrary]);

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return;
    closeFile();
    await loadBook(acceptedFiles[0], false);
  }, [closeFile, loadBook]);

  // Reabre um livro salvo na biblioteca a partir do IndexedDB.
  const openFromLibrary = useCallback(async (name: string) => {
    try {
      const blob = await idbGet(FILE_STORE, name);
      if (!blob) { alert("Arquivo não encontrado na biblioteca."); return; }
      hasCoverRef.current = !!library.find(e => e.name === name)?.cover;
      closeFile();
      await loadBook(new File([blob], name, { type: blob.type || 'application/octet-stream' }), true);
    } catch {
      alert("Não foi possível reabrir este arquivo.");
    }
  }, [closeFile, loadBook, library]);

  // Alterna fluxo de leitura do EPUB (paginado <-> rolagem contínua), recarregando o arquivo.
  const toggleEpubFlow = useCallback(() => {
    const next = epubFlowRef.current === 'paginated' ? 'scrolled' : 'paginated';
    epubFlowRef.current = next;
    localStorage.setItem('reader-epub-flow', next);
    setEpubFlow(next);
    const file = currentFileRef.current;
    if (file && fileType === 'epub') {
      closeFile();
      void loadBook(file, false);
    }
  }, [fileType, closeFile, loadBook]);

  // Lê em voz alta o capítulo/trecho atual do EPUB (voz do navegador, sem servidor).
  const speakEpub = useCallback(async () => {
    const book = bookRef.current;
    const rendition = renditionRef.current;
    if (!book || !rendition || fileType !== 'epub') return;
    if (!('speechSynthesis' in window)) { showFlash('Navegador sem suporte a leitura em voz alta.'); return; }

    if (speakingRef.current) {
      window.speechSynthesis.cancel();
      speakingRef.current = false;
      setIsSpeaking(false);
      return;
    }

    let startCfi: string | undefined;
    try { startCfi = rendition.location?.start?.cfi; } catch { /* */ }

    let text = '';
    try {
      if (startCfi) {
        const section = await book.getRange(startCfi);
        text = section?.toString() || '';
      }
    } catch { /* current chapter unavailable */ }
    if (!text.trim()) { showFlash('Não há texto para ler neste ponto.'); return; }

    const cleaned = text
      .replace(/\s+/g, ' ')
      .replace(/[“”]/g, '"')
      .trim();

    const utterance = new SpeechSynthesisUtterance(cleaned);
    utterance.lang = 'pt-BR';
    utterance.rate = 1;
    utterance.onend = () => { speakingRef.current = false; setIsSpeaking(false); };
    utterance.onerror = () => { speakingRef.current = false; setIsSpeaking(false); };
    speakingRef.current = true;
    setIsSpeaking(true);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }, [fileType, showFlash]);

  const stopTts = useCallback(() => {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    speakingRef.current = false;
    setIsSpeaking(false);
  }, []);

  // Remove um livro da biblioteca (arquivo + capa do IDB + registro + progresso).
  const removeFromLibrary = useCallback((name: string) => {
    void idbDelete(FILE_STORE, name).catch(() => {});
    void idbDelete(COVER_STORE, name).catch(() => {});
    try {
      localStorage.removeItem(`reader-progress-${name}`);
      localStorage.removeItem(`${HL_LOCAL_PREFIX}-${name}`);
      const raw = localStorage.getItem('reader-library');
      const list: LibEntry[] = raw ? JSON.parse(raw) : [];
      const next = list.filter(e => e.name !== name);
      localStorage.setItem('reader-library', JSON.stringify(next));
      setLibrary(next);
    } catch { /* ignore */ }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 
      'application/zip': ['.cbz', '.zip'],
      'application/pdf': ['.pdf'],
      'application/epub+zip': ['.epub']
    },
    multiple: false
  });

  const goToNext = useCallback(() => {
    if (fileType === 'epub' && renditionRef.current) {
      renditionRef.current.next();
    } else if (currentIndex < pages.length - 1) {
      applyZoom(1);
      setDirection(1);
      setCurrentIndex(prev => prev + 1);
    }
  }, [currentIndex, pages.length, fileType, applyZoom]);

  const goToPrev = useCallback(() => {
    if (fileType === 'epub' && renditionRef.current) {
      renditionRef.current.prev();
    } else if (currentIndex > 0) {
      applyZoom(1);
      setDirection(-1);
      setCurrentIndex(prev => prev - 1);
    }
  }, [currentIndex, fileType, applyZoom]);

  // Rodinha do mouse / pinça do trackpad:
  //  - Ctrl+wheel → zoom a partir do ponto sob o cursor;
  //  - com zoom ativo → roda arrasta a página (pan);
  //  - sem zoom → roda vira as páginas.
  useEffect(() => {
    if (fileType === 'epub' || fileType === null) return;
    const el = viewerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cur = zoomRef.current;
      if (e.ctrlKey || e.metaKey) {
        const next = clamp(cur * Math.exp(-e.deltaY * 0.0025), ZOOM_MIN, ZOOM_MAX);
        const rect = el.getBoundingClientRect();
        const px = e.clientX - (rect.left + rect.width / 2);
        const py = e.clientY - (rect.top + rect.height / 2);
        const ratio = next / cur;
        applyZoom(next, { x: px - ratio * (px - panX.get()), y: py - ratio * (py - panY.get()) });
        return;
      }
      if (cur > ZOOM_MIN) {
        const p = clampPan(panX.get() - e.deltaX, panY.get() - e.deltaY);
        panX.set(p.x);
        panY.set(p.y);
        return;
      }
      const now = Date.now();
      if (now - wheelTurnAtRef.current < 450) return;
      if (Math.abs(e.deltaY) < 30 && Math.abs(e.deltaX) < 30) return;
      if (e.deltaY > 0 || e.deltaX > 0) goToNext(); else goToPrev();
      wheelTurnAtRef.current = now;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [fileType, applyZoom, clampPan, goToNext, goToPrev, panX, panY]);

  const toggleUi = () => setIsUiVisible(!isUiVisible);

  // Total de páginas exibível para a barra de paginação / salto.
  const pageJumpTotal = useMemo(() => {
    if (!fileType) return 0;
    if (fileType === 'epub') {
      if (epubPageTotal && epubPageTotal > 0) return epubPageTotal;
      return (bookRef.current?.spine as unknown as { length?: number } | undefined)?.length || 0;
    }
    return pages.length;
  }, [fileType, epubPageTotal, pages.length]);

  // Navega para a página informada (1-based). Para EPUB usa a lista de
  // locations gerada (fallback: salta pelo índice de capítulos).
  const goToPageNum = useCallback((target: number) => {
    if (!fileType) return;
    if (fileType === 'epub') {
      const book = bookRef.current;
      const rendition = renditionRef.current;
      if (!book || !rendition) return;
      if (book.locations && book.locations.length() > 1) {
        const total = book.locations.length();
        const page = clamp(Math.round(target), 1, total);
        const progress = (page - 1) / (total - 1);
        const cfi = book.locations.cfiFromPercentage(progress);
        if (cfi) { rendition.display(cfi); return; }
      }
      const spineLen = (book.spine as unknown as { length?: number } | undefined)?.length || 0;
      if (spineLen > 0) {
        const idx = clamp(Math.round(target) - 1, 0, spineLen - 1);
        const section = book.spine.get(idx);
        if (section) rendition.display(section.cfiBase);
      }
      return;
    }
    const total = pages.length;
    if (!total) return;
    const page = clamp(Math.round(target), 1, total);
    applyZoom(1);
    setDirection(page > currentIndexRef.current ? 1 : -1);
    setCurrentIndex(page - 1);
  }, [fileType, pages.length, applyZoom]);

  const submitPageJump = useCallback((e?: React.FormEvent) => {
    e?.preventDefault();
    const total = pageJumpTotal;
    if (!total || total <= 0) return;
    const parsed = parseInt(pageInput, 10);
    if (!isFinite(parsed) || String(parsed) !== String(pageInput).trim()) {
      showFlash('Digite um número de página válido.');
      return;
    }
    const target = clamp(parsed, 1, total);
    if (parsed !== target) {
      showFlash(`Página fora do intervalo (1–${total}); ajustado para ${target}.`);
    }
    goToPageNum(target);
    setPageInput('');
  }, [pageInput, pageJumpTotal, goToPageNum, showFlash]);

  // Salta para uma porcentagem de leitura no EPUB (0–100) via slider.
  const seekEpubPercent = useCallback((percent: number) => {
    const book = bookRef.current;
    const rendition = renditionRef.current;
    if (!book || !rendition || fileType !== 'epub') return;
    const p = clamp(percent, 0, 100);
    setEpubProgress(p);
    if (book.locations && book.locations.length() > 1) {
      try {
        const cfi = book.locations.cfiFromPercentage(p / 100);
        if (cfi) { rendition.display(cfi); return; }
      } catch { /* fallback abaixo */ }
    }
    const spineLen = (book.spine as unknown as { length?: number } | undefined)?.length || 0;
    if (spineLen > 0) {
      const idx = clamp(Math.floor((p / 100) * spineLen), 0, spineLen - 1);
      const section = book.spine.get(idx);
      if (section) rendition.display(section.cfiBase);
    }
  }, [fileType]);

  // ----- Busca de texto (Ctrl+F) -----
  const snippetFromMatch = useCallback((text: string, start: number, end: number) => {
    const RADIUS = 46;
    const ctxStart = Math.max(0, start - RADIUS);
    const ctxEnd = Math.min(text.length, end + RADIUS);
    const body = text.slice(ctxStart, ctxEnd);
    const localStart = start - ctxStart;
    const localEnd = end - ctxStart;
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const highlighted = `${esc(body.slice(0, localStart))}<mark>${esc(body.slice(localStart, localEnd))}</mark>${esc(body.slice(localEnd))}`;
    return `${ctxStart > 0 ? '…' : ''}${highlighted}${ctxEnd < text.length ? '…' : ''}`;
  }, []);

  const jumpToResult = useCallback((result: SearchResult) => {
    if (result.pdfPageIndex != null) {
      applyZoom(1);
      setDirection(result.pdfPageIndex > currentIndexRef.current ? 1 : -1);
      setCurrentIndex(result.pdfPageIndex);
    } else if (result.cfi && renditionRef.current) {
      renditionRef.current.display(result.cfi);
    }
    searchNonceRef.current += 1;
    setSearchOpen(false);
    setSearchStatus('idle');
    setIsUiVisible(false);
  }, [applyZoom]);

  const jumpToToc = useCallback((item: { label: string; href: string; cfi?: string }) => {
    if (renditionRef.current) {
      const cfi = item.cfi || (item.href ? `epubcfi(${item.href})` : undefined);
      if (cfi) renditionRef.current.display(cfi).catch(() => {});
      else if (item.href) renditionRef.current.display(item.href).catch(() => {});
    }
    setTocOpen(false);
    setIsUiVisible(false);
  }, []);

  const runSearch = useCallback(async (query: string) => {
    const q = query.trim();
    if (!q) { setSearchResults([]); setSearchStatus('idle'); return; }
    const nonce = ++searchNonceRef.current;
    setSearchStatus('searching');
    setSearchResults([]);

    const escaped = escapeRegExp(q);
    const results: SearchResult[] = [];
    const push = (r: SearchResult) => {
      if (results.length >= SEARCH_RESULT_LIMIT) return false;
      results.push(r);
      return true;
    };

    try {
      if (fileType === 'pdf') {
        const pdf = pdfDocRef.current;
        if (!pdf) { setSearchStatus('error'); return; }
        const cache = pdfTextCacheRef.current;
        const re = new RegExp(escaped, 'gi');
        for (let i = 0; i < pdf.numPages && searchNonceRef.current === nonce; i++) {
          let text = cache[i];
          if (text === undefined) {
            const page = await pdf.getPage(i + 1);
            const tc = await page.getTextContent({ includeMarkedContent: true } as any);
            text = flattenPdfText(tc.items as Array<{ str?: string }>);
            cache[i] = text;
          }
          if (searchNonceRef.current !== nonce) return;
          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = re.exec(text)) !== null && searchNonceRef.current === nonce) {
            const start = m.index;
            const end = m.index + m[0].length;
            if (!push({
              id: `pdf-${i}-${start}`,
              label: `Página ${i + 1}`,
              context: snippetFromMatch(text, start, end),
              pdfPageIndex: i,
            })) break;
            if (m.index === re.lastIndex) re.lastIndex += 1;
          }
          if ((i + 1) % 4 === 0) await new Promise(r => setTimeout(r, 0));
        }
      } else if (fileType === 'epub') {
        const book = bookRef.current;
        if (!book || !book.spine) { setSearchStatus('error'); return; }
        await book.ready;
        if (searchNonceRef.current !== nonce) return;
        const spineLen = (book.spine as unknown as { length?: number }).length || 0;
        for (let i = 0; i < spineLen && searchNonceRef.current === nonce; i++) {
          let section: any;
          try {
            section = book.spine.get(i);
            await section.load(book.load.bind(book));
          } catch {
            continue;
          }
          if (searchNonceRef.current !== nonce) return;
          const doc = section.document;
          const root = (doc && (doc.body || doc.documentElement)) as HTMLElement | null;
          if (doc && root && typeof doc.createTreeWalker === 'function') {
            const segments: Array<{ node: Text; start: number; end: number; text: string }> = [];
            const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let node: Node | null;
            let offset = 0;
            while ((node = walker.nextNode())) {
              const parent = node.parentNode as Element | null;
              if (parent && /script|style|noscript|template|head/i.test(parent.tagName)) continue;
              const t = (node.nodeValue || '');
              if (!t.trim()) continue;
              segments.push({ node: node as Text, start: offset, end: offset + t.length, text: t });
              offset += t.length;
            }
            const full = segments.map(s => s.text).join('');
            const re = new RegExp(escaped, 'gi');
            let m: RegExpExecArray | null;
            while ((m = re.exec(full)) !== null && searchNonceRef.current === nonce) {
              const start = m.index;
              const end = m.index + m[0].length;
              const segIndex = (sIdx: number) => {
                let lo = 0, hi = segments.length - 1, ans = 0;
                while (lo <= hi) {
                  const mid = (lo + hi) >> 1;
                  if (segments[mid].start <= sIdx) { ans = mid; lo = mid + 1; }
                  else hi = mid - 1;
                }
                return ans;
              };
              const si = segIndex(start);
              const ei = segIndex(Math.max(start, end - 1));
              const startSeg = segments[si];
              const endSeg = segments[ei];
              let cfi = '';
              try {
                const range = doc.createRange();
                range.setStart(startSeg.node, start - startSeg.start);
                range.setEnd(endSeg.node, Math.min(endSeg.text.length, end - endSeg.start));
                cfi = section.cfiFromRange(range);
              } catch { /* range inválido */ }
              if (!push({
                id: `epub-${i}-${start}`,
                label: `Capítulo ${i + 1}`,
                context: snippetFromMatch(full, start, end),
                cfi: cfi || undefined,
              })) break;
              if (m.index === re.lastIndex) re.lastIndex += 1;
            }
          }
          try { section.unload(); } catch { /* ignore */ }
          if ((i + 1) % 3 === 0) await new Promise(r => setTimeout(r, 0));
        }
      } else {
        setSearchStatus('unsupported');
        return;
      }
      if (searchNonceRef.current !== nonce) return;
      setSearchResults(results);
      setSearchStatus('done');
    } catch (err) {
      if (searchNonceRef.current === nonce) {
        setSearchStatus('error');
        setSearchResults([]);
      }
    }
  }, [fileType, escapeRegExp, flattenPdfText, snippetFromMatch]);

  // Debounce da busca enquanto o painel está aberto.
  useEffect(() => {
    if (!searchOpen) return;
    const q = searchQuery.trim();
    if (!q) { setSearchResults([]); setSearchStatus('idle'); return; }
    const t = setTimeout(() => { runSearch(q); }, 350);
    return () => clearTimeout(t);
  }, [searchQuery, searchOpen, runSearch]);

  // Foca o campo de busca ao abrir via Ctrl/Cmd+F ou ícone.
  useEffect(() => {
    if (searchOpen) {
      const t = setTimeout(() => searchInputRef.current?.focus(), 60);
      return () => clearTimeout(t);
    }
  }, [searchOpen]);

  // Busca em arquivos de imagem não faz sentido: mostra o aviso direto.
  useEffect(() => {
    if (searchOpen && fileType === 'image') setSearchStatus('unsupported');
  }, [searchOpen, fileType]);

  // ----- Grifar / destacar texto (EPUB) -----
  const clearContentsSelection = useCallback(() => {
    try {
      const rendition = renditionRef.current;
      const contents = rendition?.getContents();
      contents?.window?.getSelection()?.removeAllRanges();
    } catch { /* ignore */ }
  }, []);

  const addHighlight = useCallback((color: HighlightKey) => {
    const popover = hlPopoverRef.current;
    const rendition = renditionRef.current;
    if (!popover || !rendition || !fileName) return;
    try {
      rendition.annotations.add(
        'highlight',
        popover.cfi,
        { color },
        undefined,
        'sepia-hl',
        { fill: HIGHLIGHT_COLORS[color].fill, 'fill-opacity': HIGHLIGHT_COLORS[color].opacity } as any,
      );
    } catch { /* cfi inválido */ }

    const existing = highlightsRef.current;
    const idx = existing.findIndex(h => h.cfi === popover.cfi);
    const next = idx >= 0
      ? existing.map((h, i) => (i === idx ? { ...h, color } : h))
      : [...existing, { cfi: popover.cfi, color }];
    highlightsRef.current = next;
    setHighlights(next);
    saveHighlights(fileName, next);

    clearContentsSelection();
    setHlPopover(null);
    hlPopoverRef.current = null;
  }, [fileName, clearContentsSelection, saveHighlights]);

  const rangesOverlap = useCallback((a: Range, b: Range): boolean => {
    try {
      const aBeforeB = a.compareBoundaryPoints(Range.END_TO_START, b) === 1;
      const bBeforeA = b.compareBoundaryPoints(Range.END_TO_START, a) === 1;
      return aBeforeB && bBeforeA;
    } catch {
      return false;
    }
  }, []);

  const removeHighlightAtSelection = useCallback(() => {
    const popover = hlPopoverRef.current;
    const rendition = renditionRef.current;
    if (!popover || !rendition || !fileName) return;

    const contents = rendition.getContents();
    let removedNames: string[] = [];
    if (contents) {
      try {
        const selRange = contents.range(popover.cfi);
        const toRemove = highlightsRef.current.filter(h => {
          try {
            const hlRange = contents.range(h.cfi);
            return rangesOverlap(selRange, hlRange);
          } catch {
            return false;
          }
        });
        toRemove.forEach(h => {
          try {
            rendition.annotations.remove(h.cfi, 'highlight');
            removedNames.push(h.cfi);
          } catch { /* já removido */ }
        });
      } catch { /* seleção inválida */ }
    }

    const next = highlightsRef.current.filter(h => !removedNames.includes(h.cfi));
    if (removedNames.length > 0) {
      highlightsRef.current = next;
      setHighlights(next);
      saveHighlights(fileName, next);
      showFlash(`${removedNames.length} grifo(s) removido(s).`);
    } else {
      showFlash('Nenhum grifo encontrado nesta seleção.');
    }
    clearContentsSelection();
    setHlPopover(null);
    hlPopoverRef.current = null;
  }, [fileName, clearContentsSelection, rangesOverlap, saveHighlights, showFlash]);

  // Exporta os grifos do EPUB como um arquivo Markdown (privado, só local).
  const exportHighlights = useCallback(async () => {
    const book = bookRef.current;
    const list = highlightsRef.current;
    if (!book || list.length === 0) { showFlash('Nenhum grifo para exportar.'); return; }

    const lines: string[] = [`# Grifos — ${fileName}`, ''];
    for (const h of list) {
      let text = '';
      try { text = (book.getRange(h.cfi)?.toString() || '').replace(/\s+/g, ' ').trim(); } catch { /* cfi órfão */ }
      const label = HIGHLIGHT_COLORS[h.color].label;
      if (text) lines.push(`- **(${label})** ${text}`);
      else lines.push(`- **(${label})** _[trecho não recuperável: ${h.cfi}]_`);
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(fileName || 'grifos').replace(/\.[a-z0-9]+$/i, '')}-grifos.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showFlash(`${list.length} grifo(s) exportado(s).`);
  }, [fileName, showFlash]);

  useEffect(() => {
    if (fileName && pages.length > 0 && fileType !== 'epub') {
      localStorage.setItem(`reader-progress-${fileName}`, currentIndex.toString());
      upsertLibrary({ name: fileName, index: currentIndex, total: pages.length, epub: false, updated: Date.now(), cover: hasCoverRef.current });
    }
  }, [currentIndex, fileName, pages.length, fileType, upsertLibrary]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        if (fileType) {
          setSearchOpen(true);
          setTimeout(() => searchInputRef.current?.focus(), 0);
        }
        return;
      }
      // Ctrl/Cmd+G → ir para página (também 'g' simples).
      if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') || (e.key.toLowerCase() === 'g' && !e.ctrlKey && !e.metaKey && !searchOpenRef.current)) {
        if (!fileType) return;
        e.preventDefault();
        setIsUiVisible(true);
        const el = document.getElementById('page-jump-input') as HTMLInputElement | null;
        setTimeout(() => { el?.focus(); el?.select(); }, 60);
        return;
      }
      // Ctrl/Cmd + '+' / '-' → zoom (PDF/CBZ), fonte (EPUB).
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === '=' || k === '+') {
          e.preventDefault();
          if (fileType === 'epub') setFontSize(prev => clamp(prev + 1, FONT_MIN, FONT_MAX));
          else applyZoom(zoomRef.current + 0.25);
          return;
        }
        if (k === '-' || k === '_') {
          e.preventDefault();
          if (fileType === 'epub') setFontSize(prev => clamp(prev - 1, FONT_MIN, FONT_MAX));
          else applyZoom(zoomRef.current - 0.25);
          return;
        }
      }
      if (e.key === 'Escape' && searchOpenRef.current) {
        e.preventDefault();
        setSearchOpen(false);
        setSearchStatus('idle');
        return;
      }
      if (e.key === 'Escape' && hlPopoverRef.current) {
        e.preventDefault();
        clearContentsSelection();
        setHlPopover(null);
        hlPopoverRef.current = null;
        return;
      }
      if (e.key === 'ArrowRight') goToNext();
      if (e.key === 'ArrowLeft') goToPrev();
      // '+'/'-' ou '1' reiniciam/ajustam o zoom (PDF/CBZ) sem Ctrl.
      if (!e.ctrlKey && !e.metaKey && fileType && fileType !== 'epub') {
        if (e.key === '+' || e.key === '=') { e.preventDefault(); applyZoom(zoomRef.current + 0.25); return; }
        if (e.key === '-' || e.key === '_') { e.preventDefault(); applyZoom(zoomRef.current - 0.25); return; }
        if (e.key === '1') { e.preventDefault(); applyZoom(ZOOM_MIN); return; }
      }
      if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (!document.fullscreenElement) document.documentElement.requestFullscreen();
        else document.exitFullscreen();
      }
      if (e.key === 'Escape' && !document.fullscreenElement) setIsUiVisible(true);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [goToNext, goToPrev, fileType, clearContentsSelection]);

  useEffect(() => {
    return () => closeFile();
  }, [closeFile]);

  const currentUrl = pages[currentIndex];
  const isUrlValid = currentUrl && typeof currentUrl === 'string' && currentUrl.length > 0;

  if (!fileType) {
    return (
      <div
        className="min-h-[100dvh] flex flex-col select-none bg-[#14110d] text-[#e8ddc8] font-mono"
        style={{ WebkitTapHighlightColor: 'transparent' }}
      >
        {/* Barra de status / cabeçalho */}
        <header className="sticky top-0 z-40 border-b border-[#3a3226] bg-[#0f0d0a]/95">
          <div className="max-w-6xl mx-auto px-5 sm:px-8 h-12 flex items-center justify-between text-xs">
            <div className="flex items-center gap-3">
              <BookOpen className="w-4 h-4 text-[#e8a766]" />
              <span className="font-semibold tracking-widest uppercase text-[#e8a766]">Sépia</span>
              <span className="hidden md:inline text-[#7a6f5d]">/reader</span>
            </div>
            <div className="flex items-center gap-4">
              <span className="hidden sm:inline text-[#7a6f5d]">v0.1.0</span>
              <span className="text-[#7a6f5d]">
                <span className="text-[#7cc46b]">●</span> offline
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); copyPix(); }}
                className="inline-flex items-center gap-1.5 px-3 h-7 border border-[#e8a766]/60 text-[#e8a766] hover:bg-[#e8a766] hover:text-[#14110d] transition-colors tracking-wide uppercase"
              >
                Apoiar via PIX
              </button>
            </div>
          </div>
        </header>

        {/* Hero — seco e direto */}
        <section className="flex-1 flex flex-col items-center justify-center px-5 sm:px-8 pt-14 pb-10">
          <div className="max-w-3xl w-full">
            <p className="text-xs tracking-widest uppercase text-[#7a6f5d] mb-3">
              leitor local · pdf / epub / cbz
            </p>
            <h1 className="text-3xl sm:text-5xl font-bold leading-tight text-left text-[#f2ead6]">
              Arquivo entra.
              <br />
              <span className="text-[#7a6f5d]">Nada sai.</span>
            </h1>
            <p className="mt-5 text-sm sm:text-base text-[#a99a80] max-w-xl leading-relaxed">
              Processamento 100% no seu navegador. Sem upload, sem conta, sem rastro.
              Abra e leia, ponto.
            </p>
          </div>

          {/* Dropzone */}
          <div className="mt-10 w-full max-w-3xl">
            <div
              {...getRootProps()}
              className={`relative border p-10 sm:p-14 text-center cursor-pointer transition-colors ${
                isDragActive
                  ? 'border-[#e8a766] bg-[#e8a766]/10'
                  : 'border-[#3a3226] bg-[#191510] hover:border-[#e8a766]/60 hover:bg-[#1d1813]'
              }`}
            >
              <input id="reader-file-input" {...getInputProps()} />

              {isLoading ? (
                <div className="flex flex-col items-center gap-3">
                  <Loader2 className="w-7 h-7 animate-spin text-[#e8a766]" />
                  <p className="text-base text-[#f2ead6]">
                    processando <span className="text-[#e8a766]">"{fileName}"</span>...
                  </p>
                  <p className="text-xs text-[#7a6f5d]">tudo local · nada sai do dispositivo</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <div className="text-[#e8a766]">
                    <BookOpen className="w-8 h-8 mx-auto mb-4" />
                  </div>
                  <p className="text-lg sm:text-xl text-[#f2ead6]">
                    solte o arquivo aqui
                  </p>
                  <p className="text-sm text-[#7a6f5d]">
                    ou <span className="text-[#e8a766] underline underline-offset-4">selecione</span> no dispositivo
                  </p>
                  <div className="flex gap-3 text-xs text-[#a99a80] mt-5">
                    {['pdf', 'epub', 'cbz', 'zip'].map((f) => (
                      <span key={f} className="border border-[#3a3226] px-2 py-0.5">.{f}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {!isLoading && (
            <div className="mt-8 w-full max-w-3xl flex items-start gap-3 border-t border-[#3a3226] pt-6">
              <Coffee className="w-4 h-4 mt-0.5 text-[#e8a766] flex-shrink-0" />
              <p className="text-xs leading-relaxed text-[#7a6f5d]">
                feito por <span className="text-[#e8a766]">leandroalvesDev</span>, sem ads. se o app é útil,
                um pix de qualquer valor mantém o servidor no ar e cobre o café.
                <button
                  onClick={(e) => { e.stopPropagation(); copyPix(); }}
                  className="ml-2 text-[#e8a766] underline underline-offset-4 hover:text-[#f2ead6]"
                >
                  {pixCopied ? 'chave copiada ✓' : 'copiar chave pix'}
                </button>
              </p>
            </div>
          )}

          <a
            href="#spec"
            className="mt-10 text-xs text-[#7a6f5d] hover:text-[#e8a766] transition-colors flex items-center gap-2"
          >
            spec + atalhos <ArrowDown className="w-3.5 h-3.5" />
          </a>
        </section>

        {/* Minha Biblioteca */}
        {library.length > 0 && (
          <section className="border-t border-[#3a3226] bg-[#0f0d0a]/50">
            <div className="max-w-5xl mx-auto px-5 sm:px-8 py-12">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-xs tracking-widest uppercase text-[#e8a766]">// minha biblioteca</h2>
                <span className="text-xs text-[#7a6f5d]">{library.length} registro(s)</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                {library.map((entry) => {
                  const pct = entry.total > 0 ? Math.round(((entry.index + 1) / entry.total) * 100) : null;
                  const label = entry.epub ? 'epub' : entry.name.split('.').pop()?.toLowerCase() || 'arq';
                  const cover = entry.cover ? coverUrls[entry.name] : undefined;
                  return (
                    <div
                      key={entry.name}
                      className="group relative border border-[#3a3226] bg-[#191510] hover:border-[#e8a766]/60 transition-colors overflow-hidden flex flex-col"
                    >
                      <button
                        onClick={() => openFromLibrary(entry.name)}
                        className="block aspect-[2/3] w-full overflow-hidden bg-[#0f0d0a] text-left"
                        title={`Reabrir ${entry.name}`}
                      >
                        {cover ? (
                          <img
                            src={cover}
                            alt=""
                            className="w-full h-full object-cover opacity-90 group-hover:opacity-100 group-hover:scale-[1.03] transition-transform duration-200"
                          />
                        ) : (
                          <div className="w-full h-full flex flex-col items-center justify-center gap-3 text-[#7a6f5d]">
                            <BookOpen className="w-10 h-10" />
                            <span className="text-xs border border-[#3a3226] px-2 py-0.5">.{label}</span>
                          </div>
                        )}
                        {pct !== null && (
                          <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/40">
                            <div className="h-full bg-[#e8a766]" style={{ width: `${pct}%` }} />
                          </div>
                        )}
                      </button>
                      <div className="px-3 py-2 flex flex-col gap-1">
                        <span className="text-xs text-[#f2ead6] truncate" title={entry.name}>{entry.name}</span>
                        <div className="flex items-center justify-between text-[10px] text-[#7a6f5d]">
                          <span>.{label} · {pct !== null ? `${pct}%` : '—'}</span>
                          <button
                            onClick={() => removeFromLibrary(entry.name)}
                            className="text-[#7a6f5d] hover:text-[#e0755f] transition-colors"
                            title="Remover da biblioteca"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        )}

        {/* Spec / detalhes técnicos */}
        <section id="spec" className="border-t border-[#3a3226] bg-[#0f0d0a]">
          <div className="max-w-6xl mx-auto px-5 sm:px-8 py-14">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
              {/* Formatos */}
              <div>
                <h2 className="text-xs tracking-widest uppercase text-[#e8a766] mb-4">// formatos</h2>
                <div className="border border-[#3a3226] divide-y divide-[#3a3226] text-sm">
                  {[
                    { f: 'pdf', spec: 'render via pdf.js · suavização + zoom', extra: '' },
                    { f: 'epub', spec: 'epub.js · reflow navegável', extra: '' },
                    { f: 'cbz/zip', spec: 'imagens descompactadas em memória', extra: '' },
                  ].map(({ f, spec }) => (
                    <div key={f} className="flex items-baseline gap-3 px-4 py-3">
                      <span className="text-[#e8a766] font-semibold w-20 flex-shrink-0">.{f}</span>
                      <span className="text-[#a99a80]">{spec}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Atalhos */}
              <div>
                <h2 className="text-xs tracking-widest uppercase text-[#e8a766] mb-4">// atalhos</h2>
                <div className="border border-[#3a3226] divide-y divide-[#3a3226] text-sm">
                  {[
                    { k: '← / →', a: 'página anterior / próxima' },
                    { k: 'ctrl+g / g', a: 'ir para página' },
                    { k: 'ctrl+f', a: 'busca no texto' },
                    { k: 'ctrl± / ±', a: 'zoom (PDF/CBZ) · fonte (EPUB)' },
                    { k: '1', a: 'resetar zoom' },
                    { k: 'f', a: 'tela cheia' },
                    { k: 'esc', a: 'mostrar interface' },
                    { k: 'toque lateral', a: 'virar página (mobile)' },
                    { k: 'pinch', a: 'zoom (mobile)' },
                  ].map(({ k, a }) => (
                    <div key={k} className="flex items-center gap-3 px-4 py-3">
                      <kbd className="border border-[#3a3226] bg-[#191510] px-2 py-0.5 text-[#f2ead6] w-24 text-center flex-shrink-0">{k}</kbd>
                      <span className="text-[#a99a80]">{a}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Rodapé técnico */}
        <footer className="border-t border-[#3a3226]">
          <div className="max-w-6xl mx-auto px-5 sm:px-8 py-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs text-[#7a6f5d]">
            <span>
              sépia · leitor online · <span className="text-[#7cc46b]">sem servidor</span>
            </span>
            <span className="font-mono">
              sépia --offline --sem-ads --por-leandroalvesDev
            </span>
          </div>
        </footer>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.25 }}
      className={`min-h-[100dvh] h-[100dvh] relative transition-colors duration-500 overflow-hidden select-none overscroll-contain ${THEME_STYLES[theme]}`}
      style={{ WebkitTapHighlightColor: 'transparent', touchAction: 'pan-y' }}
    >
      
      {/* Topbar Otimizada com Paginação Centralizada */}
      <AnimatePresence>
        {isUiVisible && (
          <motion.div 
            initial={{ y: -100 }} 
            animate={{ y: 0 }} 
            exit={{ y: -100 }}
            className={`fixed top-0 w-full px-2 sm:px-3 py-2 md:py-3 grid grid-cols-[auto_1fr_auto] items-center gap-2 md:gap-3 z-50 border-b backdrop-blur-md shadow-lg ${BAR_STYLES[theme].wrap}`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Esquerda: Fechar + Nome do arquivo */}
            <div className="flex items-center gap-1 sm:gap-2 min-w-0 max-w-[40vw] justify-self-start overflow-hidden">
              <button 
                onClick={(e) => {
                  e.stopPropagation();
                  closeFile();
                }} 
                className={`w-9 h-9 sm:w-10 sm:h-10 flex items-center justify-center rounded-full shadow-sm ring-1 ring-black/5 ${BAR_STYLES[theme].btn} hover:shadow-md active:scale-95 transition-all flex-shrink-0`}
                title="Fechar arquivo"
              >
                <X className="w-5 h-5" />
              </button>
              <span className={`font-medium text-xs sm:text-sm truncate min-w-0 flex-1 text-left ${BAR_STYLES[theme].text}`} title={fileName}>
                {fileName}
              </span>
            </div>

            {/* Centro: ferramentas de leitura */}
            <div className="flex items-center justify-center gap-1 sm:gap-2 min-w-0 max-w-full overflow-hidden px-1 justify-self-center">
              {/* Saltar para página */}
              <form
                onSubmit={submitPageJump}
                title={`Ir para página (1–${pageJumpTotal || 1})`}
                className={`flex items-center gap-0.5 sm:gap-1 h-8 sm:h-9 px-1.5 sm:px-2 rounded-full ring-1 ring-black/5 shadow-sm ${BAR_STYLES[theme].wrap}`}
              >
                <input
                  id="page-jump-input"
                  value={pageInput}
                  onChange={(e) => setPageInput(e.target.value)}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  placeholder="pg"
                  aria-label="Número da página desejada"
                  className={`w-7 sm:w-11 bg-transparent outline-none text-center text-xs sm:text-sm font-semibold placeholder:font-normal placeholder:opacity-50 ${BAR_STYLES[theme].text}`}
                />
                <span className={`text-[10px] sm:text-xs opacity-60 whitespace-nowrap ${BAR_STYLES[theme].text}`}>/ {pageJumpTotal || '—'}</span>
                <button
                  type="submit"
                  className={`hidden min-[420px]:inline text-[9px] sm:text-[10px] font-bold uppercase tracking-wide px-1 sm:px-1.5 py-1 rounded-full ${BAR_STYLES[theme].btn} active:scale-90 transition-transform`}
                  title="Ir para a página informada"
                >
                  Ir
                </button>
              </form>

              {/* Sumário (EPUB) */}
              {fileType === 'epub' && (
                <button
                  onClick={(e) => { e.stopPropagation(); setTocOpen(v => !v); }}
                  className={`w-7 h-7 sm:w-9 sm:h-9 flex items-center justify-center rounded-full shadow-sm ring-1 ring-black/5 ${tocOpen ? 'bg-[#e8a766]/30' : BAR_STYLES[theme].btn} hover:shadow-md active:scale-95 transition-all flex-shrink-0`}
                  title="Sumário (capítulos)"
                >
                  <ListTree className="w-4 h-4" />
                </button>
              )}

              {/* Busca (Ctrl+F) */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setSearchOpen(v => !v);
                }}
                className={`w-7 h-7 sm:w-9 sm:h-9 flex items-center justify-center rounded-full shadow-sm ring-1 ring-black/5 ${searchOpen ? 'bg-[#e8a766]/30' : BAR_STYLES[theme].btn} hover:shadow-md active:scale-95 transition-all flex-shrink-0`}
                title="Buscar no texto (Ctrl+F)"
              >
                <Search className="w-4 h-4" />
              </button>

              {/* Leitura em voz alta (EPUB) */}
              {fileType === 'epub' && (
                <button
                  onClick={(e) => { e.stopPropagation(); speakEpub(); }}
                  className={`hidden min-[480px]:flex w-7 h-7 sm:w-9 sm:h-9 items-center justify-center rounded-full shadow-sm ring-1 ring-black/5 ${isSpeaking ? 'bg-[#e8a766]/40' : BAR_STYLES[theme].btn} hover:shadow-md active:scale-95 transition-all flex-shrink-0`}
                  title={isSpeaking ? 'Parar leitura em voz alta' : 'Ler em voz alta (trecho atual)'}
                >
                  <Volume2 className="w-4 h-4" />
                </button>
              )}

              {/* Fluxo de leitura (EPUB): páginas individuais <-> rolagem contínua */}
              {fileType === 'epub' && (
                <button
                  onClick={(e) => { e.stopPropagation(); toggleEpubFlow(); }}
                  className={`hidden min-[480px]:flex w-7 h-7 sm:w-9 sm:h-9 items-center justify-center rounded-full shadow-sm ring-1 ring-black/5 ${BAR_STYLES[theme].btn} hover:shadow-md active:scale-95 transition-all flex-shrink-0`}
                  title={epubFlow === 'paginated' ? 'Ativar rolagem contínua' : 'Voltar a páginas individuais'}
                >
                  <ScrollText className="w-4 h-4" />
                </button>
              )}

              {/* Tamanho de fonte (EPUB) */}
              {fileType === 'epub' && (
                <div className="flex items-center gap-0.5 sm:gap-1 px-0.5 sm:px-1 flex-shrink-0" title="Tamanho do texto">
                  <button
                    onClick={(e) => { e.stopPropagation(); setFontSize(prev => clamp(prev - 1, FONT_MIN, FONT_MAX)); }}
                    disabled={fontSize <= FONT_MIN}
                    className={`w-5 h-5 sm:w-7 sm:h-7 flex items-center justify-center rounded-full shadow-sm ring-1 ring-black/5 ${BAR_STYLES[theme].btn} hover:shadow-md active:scale-90 transition-all disabled:opacity-30 disabled:pointer-events-none text-[10px] sm:text-[11px] font-bold`}
                    title="Diminuir fonte (A−)"
                  >
                    A−
                  </button>
                  <span className={`hidden sm:block text-[10px] font-mono opacity-70 w-7 text-center ${BAR_STYLES[theme].text}`}>{fontSize}px</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); setFontSize(prev => clamp(prev + 1, FONT_MIN, FONT_MAX)); }}
                    disabled={fontSize >= FONT_MAX}
                    className={`w-5 h-5 sm:w-7 sm:h-7 flex items-center justify-center rounded-full shadow-sm ring-1 ring-black/5 ${BAR_STYLES[theme].btn} hover:shadow-md active:scale-90 transition-all disabled:opacity-30 disabled:pointer-events-none text-[11px] sm:text-[13px] font-bold`}
                    title="Aumentar fonte (A+)"
                  >
                    A+
                  </button>
                </div>
              )}
            </div>

            {/* Direita: Utilitários */}
            <div className="flex items-center gap-1 sm:gap-2 min-w-0 justify-self-end">
              {fileType !== 'epub' && (
                <div className="flex items-center gap-0.5 sm:gap-1" title="Zoom (Ctrl+rodinha ou trackpad)">
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      applyZoom(zoom - 0.25);
                    }} 
                    disabled={zoom <= ZOOM_MIN}
                    className={`w-6 h-6 sm:w-8 sm:h-8 flex items-center justify-center rounded-full shadow-sm ring-1 ring-black/5 ${BAR_STYLES[theme].btn} hover:shadow-md active:scale-95 transition-all flex-shrink-0 disabled:opacity-30 disabled:pointer-events-none`} 
                    title="Diminuir zoom"
                  >
                    <ZoomOut className="w-4 h-4" />
                  </button>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      if (zoom > ZOOM_MIN) applyZoom(ZOOM_MIN);
                    }} 
                    className={`w-10 h-6 sm:w-12 sm:h-8 flex items-center justify-center rounded-full shadow-sm ring-1 ring-black/5 ${BAR_STYLES[theme].btn} hover:shadow-md active:scale-95 transition-all flex-shrink-0 text-[10px] sm:text-[11px] font-semibold tabular-nums`}
                    title="Restaurar zoom (100%)"
                  >
                    {Math.round(zoom * 100)}%
                  </button>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      applyZoom(zoom + 0.25);
                    }} 
                    disabled={zoom >= ZOOM_MAX}
                    className={`w-6 h-6 sm:w-8 sm:h-8 flex items-center justify-center rounded-full shadow-sm ring-1 ring-black/5 ${BAR_STYLES[theme].btn} hover:shadow-md active:scale-95 transition-all flex-shrink-0 disabled:opacity-30 disabled:pointer-events-none`} 
                    title="Aumentar zoom"
                  >
                    <ZoomIn className="w-4 h-4" />
                  </button>
                </div>
              )}
              <button 
                onClick={(e) => {
                  e.stopPropagation();
                  if (!document.fullscreenElement) document.documentElement.requestFullscreen();
                  else document.exitFullscreen();
                }} 
                className={`w-7 h-7 sm:w-10 sm:h-10 flex items-center justify-center rounded-full shadow-sm ring-1 ring-black/5 ${BAR_STYLES[theme].btn} hover:shadow-md active:scale-95 transition-all flex-shrink-0`}
                title="Tela Cheia"
              >
                {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
              </button>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  copyPix();
                }}
                className={`hidden sm:flex items-center gap-1.5 px-3 h-9 rounded-full shadow-sm ring-1 ring-black/5 ${BAR_STYLES[theme].btn} hover:shadow-md active:scale-95 transition-all flex-shrink-0`}
                title="Apoiar com Pix"
              >
                {pixCopied ? <Check className="w-4 h-4 text-green-400" /> : <Coffee className="w-4 h-4" />}
                <span className="text-xs font-semibold hidden sm:inline">{pixCopied ? 'Chave Copiada!' : 'Apoiar'}</span>
              </button>
              
              {fileType === 'epub' && highlights.length > 0 && (
                <button
                  onClick={(e) => { e.stopPropagation(); exportHighlights(); }}
                  className={`hidden sm:flex items-center gap-1.5 px-3 h-9 rounded-full shadow-sm ring-1 ring-black/5 ${BAR_STYLES[theme].btn} hover:shadow-md active:scale-95 transition-all flex-shrink-0`}
                  title="Exportar grifos (Markdown)"
                >
                  <FileDown className="w-4 h-4" />
                  <span className="text-xs font-semibold hidden sm:inline">Exportar Grifos</span>
                </button>
              )}

              <div className="relative flex-shrink-0">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowThemeMenu(v => !v);
                  }}
                  className={`w-7 h-7 sm:w-9 sm:h-9 flex items-center justify-center rounded-full shadow-sm ring-1 ring-black/5 ${BAR_STYLES[theme].btn} hover:shadow-md active:scale-95 transition-all`}
                  title="Tema"
                >
                  <Palette className="w-4 h-4" />
                </button>
                {showThemeMenu && (
                  <>
                    <div
                      className="fixed inset-0 z-40"
                      onClick={(e) => { e.stopPropagation(); setShowThemeMenu(false); }}
                    />
                    <div className={`absolute right-0 top-full mt-2 z-50 flex flex-col gap-1 p-1.5 rounded-xl shadow-lg backdrop-blur-md border ${BAR_STYLES[theme].wrap} bg-opacity-100`}>
                      <button onClick={(e) => { e.stopPropagation(); setTheme('cafe'); setShowThemeMenu(false); }} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg ${theme === 'cafe' ? 'bg-[#e8a766]/30' : BAR_STYLES[theme].btn} hover:shadow-sm transition-all text-xs font-medium`}><CupSoda className="w-4 h-4" /> Café</button>
                      <button onClick={(e) => { e.stopPropagation(); setTheme('light'); setShowThemeMenu(false); }} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg ${theme === 'light' ? 'bg-[#e8a766]/30' : BAR_STYLES[theme].btn} hover:shadow-sm transition-all text-xs font-medium`}><Sun className="w-4 h-4" /> Claro</button>
                      <button onClick={(e) => { e.stopPropagation(); setTheme('sepia'); setShowThemeMenu(false); }} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg ${theme === 'sepia' ? 'bg-[#e8a766]/30' : BAR_STYLES[theme].btn} hover:shadow-sm transition-all text-xs font-medium`}><BookOpen className="w-4 h-4" /> Sépia</button>
                      <button onClick={(e) => { e.stopPropagation(); setTheme('dark'); setShowThemeMenu(false); }} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg ${theme === 'dark' ? 'bg-[#e8a766]/30' : BAR_STYLES[theme].btn} hover:shadow-sm transition-all text-xs font-medium`}><Moon className="w-4 h-4" /> Escuro</button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Painel de busca (Ctrl+F) */}
      {searchOpen && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="fixed top-14 md:top-16 left-1/2 -translate-x-1/2 w-[min(92vw,540px)] z-[55] px-2"
          onClick={(e) => e.stopPropagation()}
        >
          <div className={`rounded-2xl shadow-2xl border backdrop-blur-md overflow-hidden ${BAR_STYLES[theme].wrap}`}>
            <form
              onSubmit={(e) => { e.preventDefault(); runSearch(searchQuery.trim()); }}
              className="flex items-center gap-2 px-3 py-2.5 border-b border-black/10"
            >
              <Search className={`w-4 h-4 flex-shrink-0 ${BAR_STYLES[theme].text} opacity-50`} />
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={fileType === 'image' ? 'Busca indisponível para imagens' : 'Buscar palavra ou frase…'}
                disabled={fileType === 'image'}
                className={`flex-1 min-w-0 bg-transparent outline-none text-sm ${BAR_STYLES[theme].text} placeholder:opacity-50 disabled:opacity-40`}
              />
              <button
                type="submit"
                className={`text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded-full ${BAR_STYLES[theme].btn} active:scale-90 transition-transform flex-shrink-0`}
                title="Filtrar resultados"
              >
                Buscar
              </button>
              <kbd className={`hidden sm:inline-block text-[9px] border rounded px-1 py-0.5 opacity-50 ${BAR_STYLES[theme].text}`}>Ctrl+F</kbd>
              <button
                onClick={(e) => { e.stopPropagation(); searchNonceRef.current += 1; setSearchOpen(false); setSearchStatus('idle'); }}
                className={`w-7 h-7 flex items-center justify-center rounded-full ${BAR_STYLES[theme].btn} active:scale-90 transition-all flex-shrink-0`}
                title="Fechar busca"
              >
                <X className="w-4 h-4" />
              </button>
            </form>
            <div className="max-h-[42vh] overflow-y-auto p-2 overscroll-contain">
              {searchStatus === 'unsupported' && (
                <p className="px-2 py-3 text-xs opacity-70">Este formato ({fileType === 'image' ? 'CBZ/ZIP' : fileType}) não possui texto pesquisável.</p>
              )}
              {searchStatus === 'searching' && (
                <div className="flex items-center gap-2 px-2 py-3 text-xs opacity-70">
                  <Loader2 className="w-4 h-4 animate-spin" /> buscando em todo o arquivo…
                </div>
              )}
              {searchStatus === 'error' && (
                <p className="px-2 py-3 text-xs opacity-70">Não foi possível buscar neste arquivo.</p>
              )}
              {searchStatus === 'idle' && !searchQuery.trim() && (
                <p className="px-2 py-3 text-xs opacity-50">Digite uma palavra ou frase e pressione Enter. Os resultados mostram o contexto e a página/capítulo.</p>
              )}
              {searchStatus === 'done' && searchResults.length === 0 && (
                <p className="px-2 py-3 text-xs opacity-70">Nenhum resultado para “{searchQuery.trim()}”.</p>
              )}
              {searchStatus === 'done' && searchResults.length > 0 && (
                <>
                  <p className={`text-[10px] uppercase tracking-widest opacity-50 px-2 pb-1 ${BAR_STYLES[theme].text}`}>
                    {searchResults.length} resultado{searchResults.length === 1 ? '' : 's'}
                    {searchResults.length >= SEARCH_RESULT_LIMIT ? ` (limite de ${SEARCH_RESULT_LIMIT})` : ''}
                  </p>
                  <ul className="flex flex-col gap-1">
                    {searchResults.map(r => (
                      <li key={r.id}>
                        <button
                          onClick={() => jumpToResult(r)}
                          className={`w-full text-left px-2 py-1.5 rounded-lg ${BAR_STYLES[theme].btn} active:scale-[0.99] transition-all`}
                        >
                          <span className={`text-[10px] font-bold uppercase tracking-wide ${BAR_STYLES[theme].text} opacity-60`}>{r.label}</span>
                          <p className="text-xs leading-relaxed mt-0.5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden" dangerouslySetInnerHTML={{ __html: r.context }} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        </motion.div>
      )}

      {/* Painel de sumário (TOC) do EPUB */}
      <AnimatePresence>
        {tocOpen && fileType === 'epub' && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="fixed top-14 md:top-16 left-1/2 -translate-x-1/2 w-[min(92vw,440px)] z-[54] px-2"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={`rounded-2xl shadow-2xl border backdrop-blur-md overflow-hidden ${BAR_STYLES[theme].wrap}`}>
              <div className="flex items-center gap-2 px-3 py-2.5 border-b border-black/10">
                <ListTree className={`w-4 h-4 flex-shrink-0 ${BAR_STYLES[theme].text} opacity-50`} />
                <span className={`flex-1 text-sm font-semibold ${BAR_STYLES[theme].text}`}>Sumário</span>
                <button
                  onClick={(e) => { e.stopPropagation(); setTocOpen(false); }}
                  className={`w-7 h-7 flex items-center justify-center rounded-full ${BAR_STYLES[theme].btn} active:scale-90 transition-all flex-shrink-0`}
                  title="Fechar sumário"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="max-h-[48vh] overflow-y-auto p-2 overscroll-contain">
                {toc.length === 0 ? (
                  <p className="px-2 py-3 text-xs opacity-60">Este EPUB não possui sumário (índice de capítulos).</p>
                ) : (
                  <ul className="flex flex-col gap-0.5">
                    {toc.map((item, i) => (
                      <li key={i}>
                        <button
                          onClick={() => jumpToToc(item)}
                          className={`w-full text-left px-2 py-1.5 rounded-lg ${item.subitems ? 'pl-6' : ''} ${BAR_STYLES[theme].btn} active:scale-[0.99] transition-all`}
                        >
                        <span className={`text-xs ${item.subitems ? 'opacity-70' : 'font-semibold'} ${BAR_STYLES[theme].text}`}>
                          {item.subitems && <ChevronDown className="inline w-3 h-3 mr-1 opacity-50" />}
                          {item.label}
                        </span>
                      </button>
                    </li>
                  ))}
                  </ul>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Popover contextual de grifos (EPUB) */}
      <AnimatePresence>
        {hlPopover && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 6 }}
            className="fixed z-[60]"
            style={{ left: hlPopover.x, top: hlPopover.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={`-translate-x-1/2 px-2 py-1.5 rounded-xl shadow-2xl border backdrop-blur-md ${BAR_STYLES[theme].wrap}`}>
              <div className="flex items-center gap-1.5">
                <Highlighter className={`w-3.5 h-3.5 ${BAR_STYLES[theme].text} opacity-60`} />
                {(Object.keys(HIGHLIGHT_COLORS) as HighlightKey[]).map(k => (
                  <button
                    key={k}
                    onClick={() => addHighlight(k)}
                    title={HIGHLIGHT_COLORS[k].label}
                    className="w-6 h-6 rounded-full ring-2 ring-black/20 hover:scale-110 active:scale-95 transition-transform"
                    style={{ backgroundColor: HIGHLIGHT_COLORS[k].swatch }}
                  />
                ))}
                <span className="w-px h-5 bg-black/15 mx-0.5" />
                <button
                  onClick={() => removeHighlightAtSelection()}
                  title="Remover grifo(s) da seleção"
                  className={`flex items-center gap-1 px-1.5 h-6 rounded-lg ${BAR_STYLES[theme].btn} active:scale-90 transition-all`}
                >
                  <Eraser className="w-3.5 h-3.5" />
                  <span className={`text-[10px] font-semibold whitespace-nowrap ${BAR_STYLES[theme].text}`}>Remover Grifo</span>
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Feedback discreto (toast) */}
      <AnimatePresence>
        {flashMsg && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="fixed top-16 left-1/2 -translate-x-1/2 z-[70] px-3.5 py-1.5 rounded-full shadow-lg bg-black/85 text-white text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            {flashMsg}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Barra de progresso de leitura (sutil) */}
      {(fileType !== 'epub' ? pages.length > 0 : epubTotalViaProgress > 0) && (
        <div className="fixed top-0 left-0 right-0 z-40 h-0.5 bg-black/10">
          <div
            className="h-full bg-[#e8a766] transition-[width] duration-300 ease-out"
            style={{ width: `${fileType === 'epub' ? epubProgress : ((currentIndex + 1) / pages.length) * 100}%` }}
          />
        </div>
      )}

      {/* Barra flutuante de paginação (rodapé) - wrapper fixo centraliza; motion anima por dentro */}
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50" onClick={(e) => e.stopPropagation()}>
        <AnimatePresence>
          {isUiVisible && (
            <motion.div
              initial={{ y: 100, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 100, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 400, damping: 35 }}
              className={`flex items-center justify-center gap-4 px-2 py-1 rounded-full backdrop-blur-md shadow-lg border ${BAR_STYLES[theme].wrap}`}
            >
              <button
                onClick={(e) => { e.stopPropagation(); goToPrev(); }}
                disabled={fileType !== 'epub' && currentIndex === 0}
                className={`p-1.5 rounded-full ${BAR_STYLES[theme].btn} active:scale-90 disabled:opacity-30 disabled:pointer-events-none transition-all`}
                title="Página anterior"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              {fileType === 'epub' ? (
                <div className="flex items-center gap-2 px-1 select-none" title="Progresso de leitura">
                  <span className={`text-[10px] font-mono opacity-70 min-w-[34px] text-right ${BAR_STYLES[theme].text}`}>{epubProgress}%</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={epubProgress}
                    onChange={(e) => { e.stopPropagation(); seekEpubPercent(Number(e.target.value)); }}
                    className="w-28 sm:w-40 accent-[#e8a766] cursor-pointer"
                    aria-label="Progresso de leitura"
                  />
                  <span className={`hidden sm:block text-[10px] font-mono opacity-70 ${BAR_STYLES[theme].text}`}>eBook</span>
                </div>
              ) : (
                <span className={`text-xs font-semibold tracking-wide min-w-[75px] sm:min-w-[95px] text-center ${BAR_STYLES[theme].text}`}>
                  {`Pg ${currentIndex + 1}/${pages.length}`}
                </span>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); goToNext(); }}
                disabled={fileType !== 'epub' && currentIndex === pages.length - 1}
                className={`p-1.5 rounded-full ${BAR_STYLES[theme].btn} active:scale-90 disabled:opacity-30 disabled:pointer-events-none transition-all`}
                title="Próxima página"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Viewport de Leitura com h-[100dvh] e sistema de zoom (mobile) */}
      <div ref={viewerRef} className="relative w-full h-[100dvh] overflow-hidden flex justify-center items-center max-h-screen">
        
        <div 
          id="epub-viewer" 
          className={`w-full h-full max-w-4xl mx-auto px-4 md:px-12 py-20 ${fileType === 'epub' ? 'block' : 'hidden'}`} 
        />

        {fileType !== 'epub' && (
          <motion.div
            drag={zoom > 1 ? true : "x"}
            dragConstraints={zoom > 1 ? getPanConstraints() : { left: 0, right: 0 }}
            dragElastic={0}
            dragDirectionLock
            onDragStart={() => { didDragRef.current = true; }}
            onDragEnd={(e, { offset, velocity }) => {
              if (zoom > 1) {
                setTimeout(() => { didDragRef.current = false; }, 50);
                return;
              }
              const dragDistance = offset.x;
              const dragVelocity = velocity.x;

              if (dragDistance < -25 || dragVelocity < -250) {
                goToNext();
              } else if (dragDistance > 25 || dragVelocity > 250) {
                goToPrev();
              }

              setTimeout(() => { didDragRef.current = false; }, 50);
            }}
            onTap={(e, info) => {
              if (didDragRef.current) {
                didDragRef.current = false;
                return;
              }
              const now = Date.now();
              if (lastTapRef.current && now - lastTapRef.current < 300) {
                applyZoom(zoom > 1 ? 1 : 2.5);
                lastTapRef.current = 0;
                return;
              }
              lastTapRef.current = now;
              if (zoom > 1) {
                toggleUi();
                return;
              }
              const width = window.innerWidth;
              const x = info.point.x;
              if (x < width * 0.25) {
                goToPrev();
              } else if (x > width * 0.75) {
                goToNext();
              } else {
                toggleUi();
              }
            }}
            onTouchStart={(e) => {
              if (e.touches.length === 2) {
                const [a, b] = [e.touches[0], e.touches[1]];
                pinchRef.current = {
                  dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
                  scale: zoom,
                };
                panX.set(0);
                panY.set(0);
                didDragRef.current = true;
              }
            }}
            onTouchMove={(e) => {
              if (e.touches.length === 2 && pinchRef.current) {
                const [a, b] = [e.touches[0], e.touches[1]];
                const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
                applyZoom(pinchRef.current.scale * (dist / pinchRef.current.dist));
              }
            }}
            onTouchEnd={(e) => {
              if (e.touches.length < 2) pinchRef.current = null;
              setTimeout(() => { didDragRef.current = false; }, 50);
            }}
            className="w-full h-full grid [grid-template-areas:'stack'] place-items-center will-change-transform"
            style={{ x: panX, y: panY, scale: zoom, touchAction: 'none' }}
          >
            
            <AnimatePresence custom={direction} initial={false}>
              {!isUrlValid ? (
                <motion.div 
                  key="loader"
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  style={{ gridArea: 'stack' }}
                  className="flex items-center justify-center pointer-events-none z-0 w-full h-[100dvh]"
                >
                  <Loader2 className={`w-12 h-12 animate-spin opacity-60 ${SPINNER_STYLES[theme]}`} />
                </motion.div>
              ) : (
                <motion.div
                  key={currentIndex}
                  custom={direction}
                  variants={pageFlipVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  style={{ gridArea: 'stack' }}
                  className="w-full max-w-full overflow-hidden flex justify-center items-center relative"
                >
                  <img 
                    ref={imgRef}
                    src={currentUrl} 
                    alt={`Página ${currentIndex + 1}`} 
                    className={`pointer-events-none select-none z-0 rounded-md sm:rounded-xl shadow-2xl block mx-auto max-w-full object-contain transition-[max-height] duration-200 ${isUiVisible ? 'max-h-[calc(100dvh-9rem)]' : 'max-h-[100dvh]'}`}
                  />
                </motion.div>
              )}
            </AnimatePresence>

          </motion.div>
        )}
      </div>

    </motion.div>
  );
}
