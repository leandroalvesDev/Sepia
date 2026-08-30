'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import JSZip from 'jszip';
import ePub, { Book, Rendition } from 'epubjs';
import { useDropzone } from 'react-dropzone';
import { motion, AnimatePresence, useMotionValue } from 'framer-motion';
import { 
  BookOpen, Moon, Sun, Coffee, 
  ChevronLeft, ChevronRight, X, Maximize, 
  Minimize, Loader2, ZoomIn, ZoomOut, Palette, Check, ArrowDown
} from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { idbPut, idbGet, idbDelete, FILE_STORE, COVER_STORE } from '../lib/db';

type Theme = 'light' | 'dark' | 'sepia';
type FileType = 'image' | 'pdf' | 'epub' | null;

const THEME_STYLES: Record<Theme, string> = {
  light: 'bg-gray-50 text-gray-900',
  dark: 'bg-black text-gray-300',
  sepia: 'bg-[#F4ECD8] text-[#432c21]'
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
};

const SPINNER_STYLES: Record<Theme, string> = {
  light: 'text-gray-500',
  dark: 'text-gray-400',
  sepia: 'text-[#a0602d]',
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

  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

  const applyZoom = useCallback((next: number) => {
    const z = clamp(next, 1, 4);
    setZoom(z);
    if (z === 1) {
      panX.set(0);
      panY.set(0);
    }
  }, [panX, panY]);

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
    return saved === 'light' || saved === 'dark' || saved === 'sepia' ? saved : 'sepia';
  });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showThemeMenu, setShowThemeMenu] = useState(false);
  const [pdfReady, setPdfReady] = useState(false);

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
  const renderTaskRef = useRef<any>(null);
  const loadingPagesRef = useRef<Set<number>>(new Set());
  const containerReadyRef = useRef(false);
  const containerSizeRef = useRef<{ w: number; h: number } | null>(null);
  const renderAbortRef = useRef(false);
  const hasCoverRef = useRef(false);
  const cbzRef = useRef<{ zip: JSZip | null; images: string[] }>({ zip: null, images: [] });
  
  const pagesRef = useRef<string[]>([]);
  useEffect(() => { pagesRef.current = pages; }, [pages]);
  
  const currentIndexRef = useRef(0);
  useEffect(() => { currentIndexRef.current = currentIndex; }, [currentIndex]);
  
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

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
    try { localStorage.setItem('reader-theme', theme); } catch { /* ignore */ }
  }, [theme]);

  const closeFile = useCallback(() => {
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
      flow: "paginated",
    });
    
    renditionRef.current = rendition;

    rendition.themes.register("light", { "body": { "background": "transparent", "color": "#111827" }});
    rendition.themes.register("dark", { "body": { "background": "transparent", "color": "#d1d5db" }});
    rendition.themes.register("sepia", { "body": { "background": "transparent", "color": "#432c21" }});
    rendition.themes.select(theme);

    const progressKey = `reader-progress-${file.name}`;
    const savedCfi = localStorage.getItem(progressKey);
    await rendition.display(savedCfi || undefined);
    rendition.on("relocated", (location: any) => {
      if (location?.start?.cfi) {
        localStorage.setItem(progressKey, location.start.cfi);
      }
    });
    rendition.on("click", () => setIsUiVisible(prev => !prev));

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
  const renderPdfPage = useCallback(async (targetIndex: number, qualityScale?: number) => {
    const pdf = pdfDocRef.current;
    if (!pdf || targetIndex < 0 || targetIndex >= pdf.numPages) return;
    if (pagesRef.current[targetIndex]) return;
    if (loadingPagesRef.current.has(targetIndex)) return;

    loadingPagesRef.current.add(targetIndex);

    try {
      const page = await pdf.getPage(targetIndex + 1);

      const renderScale = qualityScale ?? (() => {
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
        // Canvas dimensionado para a tela (nítido e leve, sem exageros)
        return Math.min(4, Math.max(1, fitScale));
      })();

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
            if (prev[targetIndex]) return prev;
            const newPages = [...prev];
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

  // Remove um livro da biblioteca (arquivo + capa do IDB + registro + progresso).
  const removeFromLibrary = useCallback((name: string) => {
    void idbDelete(FILE_STORE, name).catch(() => {});
    void idbDelete(COVER_STORE, name).catch(() => {});
    try {
      localStorage.removeItem(`reader-progress-${name}`);
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

  const toggleUi = () => setIsUiVisible(!isUiVisible);

  useEffect(() => {
    if (fileName && pages.length > 0 && fileType !== 'epub') {
      localStorage.setItem(`reader-progress-${fileName}`, currentIndex.toString());
      upsertLibrary({ name: fileName, index: currentIndex, total: pages.length, epub: false, updated: Date.now(), cover: hasCoverRef.current });
    }
  }, [currentIndex, fileName, pages.length, fileType, upsertLibrary]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') goToNext();
      if (e.key === 'ArrowLeft') goToPrev();
      if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        if (!document.fullscreenElement) document.documentElement.requestFullscreen();
        else document.exitFullscreen();
      }
      if (e.key === 'Escape' && !document.fullscreenElement) setIsUiVisible(true);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [goToNext, goToPrev]);

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
            className={`fixed top-0 w-full px-2 sm:px-3 py-2 md:py-3 flex items-center justify-between z-50 border-b backdrop-blur-md shadow-lg ${BAR_STYLES[theme].wrap}`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Esquerda: Fechar + Nome do arquivo */}
            <div className="flex items-center gap-1 sm:gap-2 min-w-0 max-w-[55%] flex-1 justify-self-start overflow-hidden">
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

            {/* Direita: Utilitários */}
            <div className="flex items-center gap-1 sm:gap-2 min-w-0 justify-self-end">
              {fileType !== 'epub' && (
                <div className="flex items-center gap-1">
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      applyZoom(zoom - 0.5);
                    }} 
                    className={`w-6 h-6 sm:w-9 sm:h-9 flex items-center justify-center rounded-full shadow-sm ring-1 ring-black/5 ${BAR_STYLES[theme].btn} hover:shadow-md active:scale-95 transition-all flex-shrink-0`} 
                    title="Diminuir zoom"
                  >
                    <ZoomOut className="w-4 h-4" />
                  </button>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      applyZoom(zoom > 1 ? 1 : 2);
                    }} 
                    className={`w-6 h-6 sm:w-9 sm:h-9 flex items-center justify-center rounded-full shadow-sm ring-1 ring-black/5 ${BAR_STYLES[theme].btn} hover:shadow-md active:scale-95 transition-all flex-shrink-0 text-[10px] font-semibold`}
                    title="Restaurar zoom"
                  >
                    {zoom > 1 ? '1x' : '2x'}
                  </button>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      applyZoom(zoom + 0.5);
                    }} 
                    className={`w-6 h-6 sm:w-9 sm:h-9 flex items-center justify-center rounded-full shadow-sm ring-1 ring-black/5 ${BAR_STYLES[theme].btn} hover:shadow-md active:scale-95 transition-all flex-shrink-0`} 
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
                className="flex items-center gap-1.5 px-3 h-9 rounded-full shadow-sm bg-zinc-800 text-white hover:bg-zinc-700 active:scale-95 transition-all flex-shrink-0"
                title="Apoiar com Pix"
              >
                {pixCopied ? <Check className="w-4 h-4 text-green-400" /> : <Coffee className="w-4 h-4" />}
                <span className="text-xs font-semibold hidden sm:inline">{pixCopied ? 'Chave Copiada!' : 'Apoiar'}</span>
              </button>
              
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

      {/* Barra de progresso de leitura (sutil) */}
      {fileType !== 'epub' && pages.length > 0 && (
        <div className="fixed top-0 left-0 right-0 z-40 h-0.5 bg-black/10">
          <div
            className="h-full bg-[#e8a766] transition-[width] duration-300 ease-out"
            style={{ width: `${((currentIndex + 1) / pages.length) * 100}%` }}
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
              <span className={`text-xs font-semibold tracking-wide min-w-[75px] sm:min-w-[95px] text-center ${BAR_STYLES[theme].text}`}>
                {fileType === 'epub' ? 'eBook' : `Pg ${currentIndex + 1}/${pages.length}`}
              </span>
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
                  className="w-full max-w-full overflow-hidden flex justify-center items-center"
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
