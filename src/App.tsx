import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Upload, Sparkles, BookOpen, BrainCircuit, X, Check, ArrowRight, Loader2, RefreshCcw, LogIn, LogOut, History, Info, Home as HomeIcon, Save, Trash2, ChevronLeft, Download, Menu, ChevronDown, Share2, MessageCircle, Twitter, Link } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { jsPDF } from 'jspdf';
import { processStudyImages, StudyResponse } from './services/gemini.ts';
import { cn } from './lib/utils.ts';
import { useAuth } from './contexts/AuthContext.tsx';
import { db } from './lib/firebase';
import { collection, addDoc, serverTimestamp, query, where, orderBy, onSnapshot, deleteDoc, doc } from 'firebase/firestore';
import { format } from 'date-fns';

type Page = 'landing' | 'study' | 'sessions' | 'how-it-works' | 'auth';
type AppState = 'idle' | 'ready' | 'processing' | 'result' | 'error';
type View = 'notes' | 'quiz';

export default function App() {
  const { user, loginWithGoogle, signUpWithEmail, signInWithEmail, logout, loading: authLoading } = useAuth();
  const [page, setPage] = useState<Page>('landing');
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('signup');
  const [authForm, setAuthForm] = useState({ email: '', password: '', name: '' });
  const [authError, setAuthError] = useState<string | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  const handleGoogleLogin = async () => {
    setAuthError(null);
    setIsAuthenticating(true);
    try {
      await loginWithGoogle();
    } catch (err: any) {
      console.error("Google Authenticating Error:", err);
      if (err.code === 'auth/unauthorized-domain') {
        setAuthError('Unauthorized Domain: Please add your Vercel or custom domain to the "Authorized domains" list under Firebase Console -> Authentication -> Settings -> Authorized Domains.');
      } else if (err.code === 'auth/popup-blocked') {
        setAuthError('The sign-in popup was blocked by your browser. Please allow popups or try opening the app in a new tab.');
      } else {
        setAuthError(err.message || 'Failed to sign in with Google. Note: Google pop-ups may be blocked inside iframes; please open this preview in a new tab.');
      }
    } finally {
      setIsAuthenticating(false);
    }
  };
  const [state, setState] = useState<AppState>('idle');
  const [view, setView] = useState<View>('notes');
  const [images, setImages] = useState<string[]>([]);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [referenceImages, setReferenceImages] = useState<string[]>([]);
  const [pendingReferenceFiles, setPendingReferenceFiles] = useState<File[]>([]);
  const [result, setResult] = useState<StudyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quizScores, setQuizScores] = useState<Record<number, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [savedSessions, setSavedSessions] = useState<any[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isDownloadMenuOpen, setIsDownloadMenuOpen] = useState(false);
  const [isShareMenuOpen, setIsShareMenuOpen] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [activePasteTarget, setActivePasteTarget] = useState<'primary' | 'reference'>('primary');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch saved sessions
  useEffect(() => {
    if (!user) {
      setSavedSessions([]);
      return;
    }

    const q = query(
      collection(db, 'users', user.uid, 'sessions'),
      orderBy('createdAt', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const sessions = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setSavedSessions(sessions);
    });

    return () => unsubscribe();
  }, [user]);

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      // Don't paste if we are currently processing
      if (state === 'processing') return;
      if (state !== 'idle' && state !== 'ready' && state !== 'error' && state !== 'result') return;
      
      const items = e.clipboardData?.items;
      if (!items) return;

      const newFiles: File[] = [];
      const types = new Set<string>();

      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          if (types.has('image')) continue; 
          
          const file = items[i].getAsFile();
          if (file) {
            newFiles.push(file);
            types.add('image');
          }
        }
      }

      if (newFiles.length > 0) {
        // If we are in the result page or library, pasting should probably go to a new session
        // unless specified. For now, let's stick to the active target.
        if (activePasteTarget === 'reference' && state === 'ready') {
          processReferenceFiles(newFiles);
        } else {
          processFiles(newFiles);
        }
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [state, images, activePasteTarget]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    await processFiles(files);
  };

  const processFiles = async (files: File[]) => {
    const validFiles = files.filter(f => f.type.startsWith('image/'));
    
    if (validFiles.length === 0) {
      setError('Please upload image files (PNG, JPG, or Screenshots).');
      setState('error');
      return;
    }

    try {
      const newImages: string[] = [];
      const newPendingFiles: File[] = [];

      for (const file of validFiles) {
        const dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.readAsDataURL(file);
        });
        newImages.push(dataUrl);
        newPendingFiles.push(file);
      }

      setImages(prev => [...prev, ...newImages]);
      setPendingFiles(prev => [...prev, ...newPendingFiles]);
      setState('ready');
      setPage('study');
    } catch (err) {
      setError('Failed to read files.');
      setState('error');
    }
  };

  const processReferenceFiles = async (files: File[]) => {
    const validFiles = files.filter(f => f.type.startsWith('image/'));
    if (validFiles.length === 0) return;
    
    for (const file of validFiles) {
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      });
      setReferenceImages(prev => [...prev, dataUrl]);
      setPendingReferenceFiles(prev => [...prev, file]);
    }
  };

  const handleProcess = async (mode: 'notes' | 'quiz' | 'both') => {
    if (pendingFiles.length === 0 || images.length === 0) return;
    
    setState('processing');
    setView(mode === 'quiz' ? 'quiz' : 'notes');
    setError(null);

    const imageInputs = images.map((img, idx) => ({
      base64: img.split(',')[1],
      mimeType: pendingFiles[idx].type
    }));

    const referenceInputs = referenceImages.map((img, idx) => ({
      base64: img.split(',')[1],
      mimeType: pendingReferenceFiles[idx].type
    }));

    try {
      let response = await processStudyImages(imageInputs, mode, referenceInputs);
      
      // Sanitize the response to handle literal \n sequences from AI
      if (response && response.notes) {
        response.notes.detailedContent = (response.notes.detailedContent || "").replace(/\\n/g, '\n');
        response.notes.summary = (response.notes.summary || "").replace(/\\n/g, '\n');
        response.notes.keyPoints = (response.notes.keyPoints || []).map(kp => kp.replace(/\\n/g, '\n'));
      }
      
      if (response && response.quiz) {
        response.quiz = response.quiz.map(q => ({
          ...q,
          question: q.question.replace(/\\n/g, '\n'),
          options: q.options.map(o => o.replace(/\\n/g, '\n')),
          explanation: q.explanation.replace(/\\n/g, '\n')
        }));
      }

      setResult(response);
      setState('result');
      
      // Auto-save if logged in
      if (user) {
        saveToCloud(response);
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Failed to process images. Make sure they contain readable text.');
      setState('error');
    }
  };

  const saveToCloud = async (studyData: StudyResponse) => {
    if (!user) return;
    setIsSaving(true);
    try {
      await addDoc(collection(db, 'users', user.uid, 'sessions'), {
        userId: user.uid,
        title: studyData.notes.title || 'Untitled Session',
        summary: studyData.notes.summary,
        keyPoints: studyData.notes.keyPoints,
        detailedContent: studyData.notes.detailedContent,
        quiz: studyData.quiz,
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      const errInfo = {
        error: err instanceof Error ? err.message : String(err),
        operationType: 'create',
        path: `users/${user.uid}/sessions`,
        authInfo: {
          userId: user.uid,
          email: user.email,
        }
      };
      console.error('Firestore Error: ', JSON.stringify(errInfo));
      throw new Error(JSON.stringify(errInfo));
    } finally {
      setIsSaving(false);
    }
  };

  const deleteSession = async (sessionId: string) => {
    if (!user) return;
    try {
      await deleteDoc(doc(db, 'users', user.uid, 'sessions', sessionId));
    } catch (err: any) {
      const errMessage = err?.message || String(err);
      console.error('Delete failed:', errMessage);
      setError(`Failed to delete session: ${errMessage}`);
    }
  };

  const reset = () => {
    setPage('landing');
    setState('idle');
    setResult(null);
    setImages([]);
    setPendingFiles([]);
    setReferenceImages([]);
    setPendingReferenceFiles([]);
    setError(null);
    setQuizScores({});
    setView('notes');
  };

  const startStudy = () => {
    setPage('study');
    setState('idle');
  };

  const openSession = (session: any) => {
    setResult({
      notes: {
        title: session.title,
        summary: session.summary,
        keyPoints: session.keyPoints,
        detailedContent: session.detailedContent,
      },
      quiz: session.quiz
    });
    setState('result');
    setPage('study');
    setView('notes');
  };

  const downloadResult = (include: 'notes' | 'quiz' | 'both' = 'both') => {
    if (!result) return;
    
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 20;
    const contentWidth = pageWidth - (margin * 2);
    let y = 20;

    const checkPageBreak = (neededHeight: number) => {
      if (y + neededHeight > 275) {
        doc.addPage();
        y = 30; // Better margin on new page
        return true;
      }
      return false;
    };

    const addText = (text: string, fontSize = 11, isBold = false, color = [30, 41, 59], indent = 0) => {
      doc.setFontSize(fontSize);
      doc.setFont('helvetica', isBold ? 'bold' : 'normal');
      doc.setTextColor(color[0], color[1], color[2]);
      
      const lines = doc.splitTextToSize(text, contentWidth - indent);
      const lineHeight = fontSize * 0.5;
      
      checkPageBreak(lines.length * lineHeight + 2);
      
      doc.text(lines, margin + indent, y);
      y += (lines.length * lineHeight) + 2;
    };

    const addRichText = (text: string, fontSize = 11, color = [30, 41, 59], indent = 0) => {
      doc.setFontSize(fontSize);
      doc.setTextColor(color[0], color[1], color[2]);
      
      const lineHeight = fontSize * 0.6;
      const xStart = margin + indent;
      
      // Tokenize by bold markers ** while keeping them in the resulting array
      const pieces = text.split(/(\*\*)/);
      let isBold = false;
      let currentX = xStart;

      pieces.forEach(piece => {
        if (piece === '**') {
          isBold = !isBold;
          return;
        }
        if (!piece) return;

        doc.setFont('helvetica', isBold ? 'bold' : 'normal');
        
        // Split text content into words and whitespace to handle wrapping
        const tokens = piece.split(/(\s+)/);
        tokens.forEach(token => {
          if (!token) return;
          
          const tokenWidth = doc.getTextWidth(token);

          // If it's just whitespace and we're at the start of a line, skip it
          if (token.trim() === '' && currentX === xStart) {
            return;
          }

          if (currentX + tokenWidth > margin + contentWidth) {
            y += lineHeight;
            currentX = xStart;
            checkPageBreak(lineHeight);
            
            // If it was whitespace that caused the wrap, don't draw it at the start of new line
            if (token.trim() === '') return;
          }

          doc.text(token, currentX, y);
          currentX += tokenWidth;
        });
      });

      y += lineHeight + 2;
    };

    const renderMarkdownLine = (line: string) => {
      let trimmed = line.trim();
      if (!trimmed) {
        y += 4;
        return;
      }

      // Automatically bold "Term: " patterns if not already bold
      if (!trimmed.startsWith('#') && !trimmed.startsWith('**') && !trimmed.startsWith('---')) {
        // Match bullet/numbered list with term: rest
        const listMatch = trimmed.match(/^((?:[-*]|\d+\.)\s+)([^:]+)(:.*)$/);
        const paragraphMatch = trimmed.match(/^([^:]+)(:.*)$/);
        
        if (listMatch) {
          const [_, prefix, term, rest] = listMatch;
          // Only bold if reasonably short term and not already bold
          if (term.length < 50 && !term.trim().startsWith('**')) {
            trimmed = `${prefix}**${term.trim()}**${rest}`;
          }
        } else if (paragraphMatch && !trimmed.match(/^[*-]|\d+\./)) {
          const [_, term, rest] = paragraphMatch;
          if (term.length < 50 && !term.includes('http') && !term.trim().startsWith('**')) {
            trimmed = `**${term.trim()}**${rest}`;
          }
        }
      }

      // Headings
      if (trimmed.startsWith('# ')) {
        y += 4;
        addText(trimmed.replace('# ', ''), 22, true, [15, 23, 42]);
        y += 4;
      } else if (trimmed.startsWith('## ')) {
        y += 3;
        addText(trimmed.replace('## ', ''), 18, true, [30, 41, 59]);
        y += 2;
      } else if (trimmed.startsWith('### ')) {
        y += 2;
        addText(trimmed.replace('### ', ''), 14, true, [51, 65, 85]);
        y += 1;
      } 
      // Bullets
      else if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
        const text = trimmed.substring(2);
        const bulletSymbol = '•';
        const bulletWidth = 5;
        
        doc.setFontSize(11);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(71, 85, 105);
        
        doc.text(bulletSymbol, margin, y);
        addRichText(text, 11, [71, 85, 105], bulletWidth);
      }
      // Horizontal Rule
      else if (trimmed === '---' || trimmed === '***') {
        y += 2;
        doc.setDrawColor(226, 232, 240);
        doc.line(margin, y, pageWidth - margin, y);
        y += 6;
      }
      // Regular Paragraph
      else {
        addRichText(trimmed, 11);
      }
    };

    // Style Header
    doc.setFillColor(79, 70, 229); // Indigo-600
    doc.rect(0, 0, pageWidth, 40, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(24);
    doc.setFont('helvetica', 'bold');
    doc.text('RIVYSO', margin, 25);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text('Your Smarter Study Companion', margin, 32);
    
    y = 55;
    
    if (include === 'notes' || include === 'both') {
      // Main Title
      addText(result.notes.title, 26, true, [15, 23, 42]);
      y += 8;
      
      // Summary Section
      addText('EXECUTIVE SUMMARY', 10, true, [79, 70, 229]);
      y += 2;
      addText(result.notes.summary, 12, false, [71, 85, 105]);
      y += 8;
      
      // Key Concepts
      addText('KEY CONCEPTS', 10, true, [79, 70, 229]);
      y += 2;
      result.notes.keyPoints.forEach(p => {
        renderMarkdownLine(`* ${p}`);
      });
      y += 8;

      // Detailed Content
      addText('DETAILED STUDY NOTES', 10, true, [79, 70, 229]);
      y += 4;
      
      const contentLines = (result.notes.detailedContent || "").split('\n');
      contentLines.forEach(line => renderMarkdownLine(line));
    }

    if ((include === 'quiz' || include === 'both') && result.quiz && result.quiz.length > 0) {
      if (include === 'both') {
        doc.addPage();
        y = 30;
      }
      
      doc.setFillColor(79, 70, 229);
      doc.rect(0, 0, pageWidth, 15, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(14);
      doc.setFont('helvetica', 'bold');
      doc.text('PRACTICE QUIZ', margin, 10);
      
      y = 30;
      doc.setTextColor(30, 41, 59);
      
      result.quiz.forEach((q, i) => {
        checkPageBreak(40); // Estimate space for a question
        
        doc.setFontSize(12);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(30, 41, 59);
        const qLines = doc.splitTextToSize(`${i + 1}. ${q.question}`, contentWidth);
        doc.text(qLines, margin, y);
        y += (qLines.length * 7) + 4;

        q.options.forEach((o, oi) => {
          const prefix = String.fromCharCode(65 + oi);
          doc.setFontSize(11);
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(71, 85, 105);
          const oLines = doc.splitTextToSize(`${prefix}. ${o}`, contentWidth - 10);
          doc.text(oLines, margin + 10, y);
          y += (oLines.length * 6) + 2;
        });

        y += 2;
        doc.setFontSize(10);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(16, 185, 129); // Emerald-600
        doc.text(`Correct: Option ${q.correctAnswer}`, margin + 10, y);
        y += 5;
        
        doc.setFont('helvetica', 'italic');
        doc.setTextColor(100, 116, 139); // Slate-500
        const expLines = doc.splitTextToSize(`Explanation: ${q.explanation}`, contentWidth - 10);
        doc.text(expLines, margin + 10, y);
        y += (expLines.length * 5) + 12;
      });
    }

    const filename = include === 'both' ? 'Full_Guide' : (include === 'notes' ? 'Notes' : 'Quiz');
    const safeTitle = result.notes.title.replace(/[^a-z0-9]/gi, '_').substring(0, 30);
    doc.save(`${safeTitle}_${filename}.pdf`);
    setIsDownloadMenuOpen(false);
  };

  const handleShare = async (include: 'notes' | 'quiz' | 'both' = 'both') => {
    if (!result) return;
    
    const title = result.notes.title || 'Study Session';
    const platformText = `Check out my ${include === 'both' ? 'revision notes and quiz' : include === 'notes' ? 'revision notes' : 'practice quiz'} on "${title}" using Rivyso! 🚀`;
    
    try {
      if (navigator.share) {
        await navigator.share({
          title: 'Rivyso Study Session',
          text: platformText,
          url: window.location.href,
        });
      } else {
        // Fallback for desktop: Copy to clipboard and show simple toast/alert
        await navigator.clipboard.writeText(window.location.href);
        alert('App link copied to clipboard! You can now paste and share it.');
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('Share failed:', err);
      }
    } finally {
      setIsShareMenuOpen(false);
    }
  };

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setIsAuthenticating(true);
    try {
      if (authMode === 'signup') {
        await signUpWithEmail(authForm.email, authForm.password, authForm.name);
      } else {
        await signInWithEmail(authForm.email, authForm.password);
      }
      setPage('landing');
    } catch (err: any) {
      setAuthError(err.message);
    } finally {
      setIsAuthenticating(false);
    }
  };

  const removeImage = (index: number) => {
    const nextImages = [...images];
    const nextFiles = [...pendingFiles];
    nextImages.splice(index, 1);
    nextFiles.splice(index, 1);
    
    setImages(nextImages);
    setPendingFiles(nextFiles);
    
    if (nextImages.length === 0) {
      setState('idle');
    }
  };

  const handleReferenceFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    await processReferenceFiles(files);
  };

  const removeReferenceImage = (index: number) => {
    const nextImages = [...referenceImages];
    const nextFiles = [...pendingReferenceFiles];
    nextImages.splice(index, 1);
    nextFiles.splice(index, 1);
    setReferenceImages(nextImages);
    setPendingReferenceFiles(nextFiles);
  };

  return (
    <div className="min-h-screen font-sans selection:bg-indigo-100 pb-20 overflow-x-hidden">
      {/* Persistent Left Sidebar for Desktop */}
      <aside className="fixed top-0 left-0 bottom-0 w-64 bg-white border-r border-slate-200 hidden lg:flex flex-col z-[40]">
        <div className="p-6">
          <div className="flex items-center gap-2 cursor-pointer mb-10" onClick={reset}>
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
              <BookOpen className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-xl font-display italic font-black text-indigo-950 tracking-tight">Rivyso</h1>
          </div>

          <nav className="space-y-1.5">
            {[
              { id: 'landing', label: 'Home', icon: <HomeIcon className="w-5 h-5" /> },
              { id: 'how-it-works', label: 'How it works', icon: <Info className="w-5 h-5" /> },
              { id: 'sessions', label: 'My Library', icon: <History className="w-5 h-5" />, authRequired: true },
            ].map((item) => {
              if (item.authRequired && !user) return null;
              return (
                <button 
                  key={item.id}
                  onClick={() => setPage(item.id as Page)}
                  className={cn(
                    "w-full flex items-center gap-4 px-4 py-3 rounded-xl text-sm font-bold transition-all",
                    page === item.id 
                      ? "bg-indigo-50 text-indigo-600 shadow-sm" 
                      : "text-slate-500 hover:bg-slate-50 hover:text-indigo-600 text-left"
                  )}
                >
                  {item.icon}
                  {item.label}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="mt-auto p-6 border-t border-slate-100">
          {user ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3 px-1">
                 <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 font-bold overflow-hidden border border-slate-200">
                  {user.photoURL ? <img src={user.photoURL} className="w-full h-full object-cover" alt="" /> : user.email?.charAt(0).toUpperCase()}
                 </div>
                 <div className="min-w-0">
                   <p className="text-xs font-black text-slate-900 truncate">{user.displayName || user.email}</p>
                   <p className="text-[10px] text-slate-400 truncate">{user.email}</p>
                 </div>
              </div>
              <button 
                onClick={logout}
                className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-xs font-bold text-red-500 hover:bg-red-50 transition-all text-left"
              >
                <LogOut className="w-4 h-4" />
                Sign Out
              </button>
            </div>
          ) : (
            <button 
              onClick={() => setPage('auth')}
              className="w-full py-3.5 bg-indigo-600 text-white rounded-xl text-sm font-black shadow-lg shadow-indigo-100 hover:bg-indigo-700 transition-all active:scale-95"
            >
              Sign In to Sync
            </button>
          )}
        </div>
      </aside>

      {/* Header */}
      <header className="fixed top-0 left-0 lg:left-64 right-0 z-50 bg-white/80 backdrop-blur-md border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button 
              onClick={() => setIsSidebarOpen(true)}
              className="p-2 hover:bg-slate-100 rounded-lg transition-colors text-slate-600 lg:hidden"
            >
              <Menu className="w-6 h-6" />
            </button>
            <div className="flex items-center gap-2 cursor-pointer lg:hidden" onClick={reset}>
              <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
                <BookOpen className="w-5 h-5 text-white" />
              </div>
              <h1 className="text-xl font-display italic font-black text-indigo-950 tracking-tight">Rivyso</h1>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-4">
            {authLoading ? (
              <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
            ) : user ? (
              <div className="flex items-center gap-3">
                <div className="hidden xs:block text-right">
                  <p className="text-[10px] font-bold text-slate-900 leading-none truncate max-w-[100px]">{user.displayName || user.email}</p>
                </div>
                {user.photoURL ? (
                  <img src={user.photoURL} className="w-8 h-8 rounded-full border border-slate-200" alt="Profile" />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 font-bold text-xs uppercase shrink-0">
                    {user.email?.charAt(0)}
                  </div>
                )}
              </div>
            ) : (
              <button 
                onClick={() => setPage('auth')}
                className="flex items-center gap-2 px-3 py-1.5 sm:px-4 sm:py-2 bg-indigo-600 text-white rounded-xl text-xs sm:text-sm font-bold hover:bg-indigo-700 transition-all active:scale-95 shadow-lg shadow-indigo-100"
              >
                <LogIn className="w-4 h-4" />
                <span className="hidden xs:inline">Join Free</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Sidebar Overlay */}
      <AnimatePresence>
        {isSidebarOpen && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsSidebarOpen(false)}
              className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-[100]"
            />
            <motion.div 
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed top-0 left-0 bottom-0 w-72 bg-white z-[101] shadow-2xl p-6 flex flex-col"
            >
              <div className="flex items-center justify-between mb-10">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
                    <BookOpen className="w-5 h-5 text-white" />
                  </div>
                  <h1 className="text-xl font-display italic font-black text-indigo-950 tracking-tight text-left">Rivyso</h1>
                </div>
                <button onClick={() => setIsSidebarOpen(false)} className="p-2 hover:bg-slate-100 rounded-full text-slate-400">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <nav className="space-y-2 flex-1">
                {[
                  { id: 'landing', label: 'Home', icon: <HomeIcon className="w-5 h-5" /> },
                  { id: 'how-it-works', label: 'How it works', icon: <Info className="w-5 h-5" /> },
                  { id: 'sessions', label: 'Library', icon: <History className="w-5 h-5" />, authRequired: true },
                ].map((item) => {
                  if (item.authRequired && !user) return null;
                  return (
                    <button 
                      key={item.id}
                      onClick={() => {
                        setPage(item.id as Page);
                        setIsSidebarOpen(false);
                      }}
                      className={cn(
                        "w-full flex items-center gap-4 px-4 py-3 rounded-2xl text-sm font-bold transition-all",
                        page === item.id ? "bg-indigo-50 text-indigo-600" : "text-slate-500 hover:bg-slate-50 hover:text-indigo-600 text-left"
                      )}
                    >
                      {item.icon}
                      {item.label}
                    </button>
                  );
                })}
              </nav>

              <div className="pt-6 border-t border-slate-100 space-y-4">
                {user ? (
                  <>
                    <div className="flex items-center gap-3 px-2">
                       <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 font-bold">
                        {user.photoURL ? <img src={user.photoURL} className="w-10 h-10 rounded-full" alt="" /> : user.email?.charAt(0).toUpperCase()}
                       </div>
                       <div className="min-w-0">
                         <p className="text-sm font-bold text-slate-900 truncate">{user.displayName || user.email}</p>
                         <p className="text-[10px] text-slate-400 truncate">{user.email}</p>
                       </div>
                    </div>
                    <button 
                      onClick={() => {
                        logout();
                        setIsSidebarOpen(false);
                      }}
                      className="w-full flex items-center gap-4 px-4 py-3 rounded-2xl text-sm font-bold text-red-500 hover:bg-red-50 transition-all text-left"
                    >
                      <LogOut className="w-5 h-5" />
                      Sign Out
                    </button>
                  </>
                ) : (
                  <button 
                    onClick={() => {
                      setPage('auth');
                      setIsSidebarOpen(false);
                    }}
                    className="w-full py-4 bg-indigo-600 text-white rounded-2xl font-black shadow-lg shadow-indigo-100 hover:bg-indigo-700 transition-all"
                  >
                    Join Rivyso Free
                  </button>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <main className="pt-24 px-4 sm:px-6 max-w-6xl mx-auto lg:ml-64 lg:max-w-none lg:px-12">
        <AnimatePresence mode="wait">
          {page === 'landing' && (
            <motion.div
              key="landing"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="py-12 md:py-24"
            >
              <div className="grid lg:grid-cols-2 gap-16 items-center">
                <div className="text-left space-y-6 md:space-y-8">
                  <h2 className="text-4xl xs:text-5xl md:text-7xl font-display italic font-black text-slate-950 leading-[0.9] tracking-tighter text-balance">
                    Simplify Your Revision.<br className="hidden sm:block" />
                    Master Your Exams.
                  </h2>
                  <p className="text-slate-500 text-lg md:text-xl max-w-xl leading-relaxed font-medium">
                    Upload any study material and instantly get simplified revision summaries, key concepts, and possible exam questions.
                  </p>
                  
                  <div className="flex flex-wrap gap-4">
                    <button 
                      onClick={startStudy}
                      className="px-8 py-4 bg-indigo-600 text-white rounded-2xl font-black shadow-xl shadow-indigo-100 hover:bg-indigo-700 hover:translate-y-[-2px] transition-all flex items-center gap-3 group"
                    >
                      Start Revising
                      <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                    </button>
                    <button 
                      onClick={() => setPage('how-it-works')}
                      className="px-8 py-4 bg-white border border-slate-200 rounded-2xl font-bold text-slate-600 hover:bg-slate-50 transition-all"
                    >
                      How it works
                    </button>
                  </div>
                </div>

                <div className="relative group perspective-1000">
                  <div className="absolute -inset-8 bg-gradient-to-tr from-indigo-500/20 to-purple-500/20 blur-3xl opacity-50 group-hover:opacity-100 transition-opacity" />
                  <div className="relative bg-white p-4 rounded-[2.5rem] shadow-2xl border border-slate-100 transform rotate-2 group-hover:rotate-0 transition-transform duration-700">
                    <div className="bg-slate-50 rounded-[2rem] aspect-[4/3] flex items-center justify-center overflow-hidden">
                       <div className="p-8 text-center space-y-4">
                          <div className="w-16 h-16 bg-white rounded-2xl shadow-sm flex items-center justify-center mx-auto mb-4">
                            <BookOpen className="w-8 h-8 text-indigo-600" />
                          </div>
                          <div className="h-4 w-32 bg-slate-200 rounded-full mx-auto" />
                          <div className="h-3 w-48 bg-slate-100 rounded-full mx-auto" />
                          <div className="h-3 w-40 bg-slate-100 rounded-full mx-auto" />
                          <div className="pt-4 flex gap-2 justify-center">
                            <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center">
                              <Check className="w-4 h-4 text-emerald-600" />
                            </div>
                            <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center">
                              <Sparkles className="w-4 h-4 text-indigo-600" />
                            </div>
                          </div>
                       </div>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {page === 'auth' && (
            <motion.div
              key="auth"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="py-12 max-w-md mx-auto"
            >
              <div className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-xl space-y-8">
                <div className="text-center">
                  <h2 className="text-3xl font-display italic font-black text-slate-950 mb-2">
                    {authMode === 'login' ? 'Welcome Back' : 'Create Account'}
                  </h2>
                  <p className="text-slate-500 text-sm">
                    {authMode === 'login' ? 'Sync your notes across all your devices.' : 'Join thousands of students studying smarter.'}
                  </p>
                </div>

                <form onSubmit={handleAuth} className="space-y-4">
                  {authMode === 'signup' && (
                    <div className="space-y-1.5">
                      <label className="text-xs font-bold text-slate-400 uppercase tracking-widest ml-1">Name</label>
                      <input 
                        required
                        type="text"
                        placeholder="John Doe"
                        className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none transition-all placeholder:text-slate-300"
                        value={authForm.name}
                        onChange={e => setAuthForm(prev => ({ ...prev, name: e.target.value }))}
                      />
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-400 uppercase tracking-widest ml-1">Email</label>
                    <input 
                      required
                      type="email"
                      placeholder="you@email.com"
                      className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none transition-all placeholder:text-slate-300"
                      value={authForm.email}
                      onChange={e => setAuthForm(prev => ({ ...prev, email: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-400 uppercase tracking-widest ml-1">Password</label>
                    <input 
                      required
                      type="password"
                      placeholder="••••••••"
                      className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none transition-all placeholder:text-slate-300"
                      value={authForm.password}
                      onChange={e => setAuthForm(prev => ({ ...prev, password: e.target.value }))}
                    />
                  </div>

                  {authError && (
                    <p className="text-xs font-bold text-red-500 px-1">{authError}</p>
                  )}

                  <button 
                    type="submit"
                    disabled={isAuthenticating}
                    className="w-full py-4 bg-indigo-600 text-white rounded-xl font-black shadow-lg shadow-indigo-100 hover:bg-indigo-700 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {isAuthenticating ? <Loader2 className="w-5 h-5 animate-spin" /> : (authMode === 'login' ? 'Login' : 'Create Account')}
                  </button>
                </form>

                <div className="relative">
                  <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-slate-100"></div></div>
                  <div className="relative flex justify-center text-xs uppercase tracking-widest font-bold"><span className="bg-white px-4 text-slate-400">Or continue with</span></div>
                </div>

                <button 
                  onClick={handleGoogleLogin}
                  className="w-full py-4 bg-white border border-slate-200 text-slate-900 rounded-xl font-bold hover:bg-slate-50 transition-all flex items-center justify-center gap-3 active:scale-95 shadow-sm"
                >
                  <img src="https://www.google.com/favicon.ico" className="w-5 h-5" alt="Google" />
                  Google Account
                </button>

                <p className="text-center text-sm text-slate-500">
                  {authMode === 'login' ? "Don't have an account?" : "Already have an account?"}
                  <button 
                    onClick={() => {
                      setAuthMode(authMode === 'login' ? 'signup' : 'login');
                      setAuthError(null);
                    }}
                    className="ml-1 text-indigo-600 font-bold hover:underline"
                  >
                    {authMode === 'login' ? 'Sign up' : 'Log in'}
                  </button>
                </p>
              </div>
            </motion.div>
          )}

          {page === 'how-it-works' && (
            <motion.div
              key="how-it-works"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="py-12 max-w-4xl mx-auto"
            >
              <button 
                onClick={reset}
                className="mb-8 flex items-center gap-2 text-slate-500 hover:text-indigo-600 font-bold transition-colors"
              >
                <ChevronLeft className="w-5 h-5" />
                Back to Home
              </button>
              
              <h2 className="text-4xl md:text-5xl font-display italic font-black text-slate-950 mb-12">The Rivyso Method</h2>
              
                <div className="grid md:grid-cols-3 gap-6 sm:gap-8">
                  {[
                    { 
                      icon: <Upload className="w-5 h-5 sm:w-6 sm:h-6" />, 
                      title: "Capture", 
                      desc: "Capture photos of textbook pages, lecture notes, or paste screenshots directly from your computer." 
                    },
                    { 
                      icon: <Sparkles className="w-5 h-5 sm:w-6 sm:h-6" />, 
                      title: "Analyze", 
                      desc: "The system extracts the most critical information, stripping away the fluff to reveal the core concepts." 
                    },
                    { 
                      icon: <BrainCircuit className="w-5 h-5 sm:w-6 sm:h-6" />, 
                      title: "Learn", 
                      desc: "Review clean summaries and test your understanding with custom-generated practice quizzes." 
                    }
                  ].map((step, i) => (
                    <div key={i} className="bg-white p-6 sm:p-8 rounded-[2rem] border border-slate-200 shadow-sm space-y-4">
                      <div className="w-10 h-10 sm:w-12 sm:h-12 bg-indigo-50 rounded-xl flex items-center justify-center text-indigo-600">
                        {step.icon}
                      </div>
                      <h3 className="text-lg sm:text-xl font-black text-slate-900">{step.title}</h3>
                      <p className="text-slate-500 leading-relaxed text-xs sm:text-sm">{step.desc}</p>
                    </div>
                  ))}
                </div>
                
                <div className="mt-12 sm:mt-16 bg-indigo-600 rounded-[2.5rem] sm:rounded-[3rem] p-8 sm:p-12 text-center text-white">
                  <h3 className="text-2xl sm:text-3xl font-display italic font-black mb-4">Ready to start?</h3>
                  <p className="text-indigo-100 max-w-lg mx-auto mb-8 text-sm sm:text-base font-medium">It's completely free and works on any device. Just log in with your student account to sync your notes across devices.</p>
                  <button 
                    onClick={startStudy}
                    className="w-full sm:w-auto px-8 sm:px-10 py-4 sm:py-5 bg-white text-indigo-600 rounded-2xl font-black hover:bg-slate-50 transition-all active:scale-95 shadow-xl shadow-indigo-800/20"
                  >
                    Get Started Now
                  </button>
                </div>
            </motion.div>
          )}

          {page === 'sessions' && (
            <motion.div
              key="sessions"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="py-6 md:py-12"
            >
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-10 px-1">
                <div>
                  <h2 className="text-3xl sm:text-4xl font-display italic font-black text-slate-950 mb-2">My Library</h2>
                  <p className="text-slate-500 text-sm">Your archive of revision notes and quizzes, accessible anywhere.</p>
                </div>
                <button 
                  onClick={startStudy}
                  className="w-full sm:w-auto px-6 py-3 bg-indigo-600 text-white rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-indigo-700 transition-all active:scale-95 shadow-lg shadow-indigo-100"
                >
                  <Upload className="w-4 h-4" />
                  New Session
                </button>
              </div>

              {savedSessions.length === 0 ? (
                <div className="bg-white rounded-[2.5rem] border-2 border-dashed border-slate-100 py-24 text-center px-6">
                  <div className="w-16 h-16 bg-slate-50 rounded-2xl flex items-center justify-center mx-auto mb-6">
                    <BookOpen className="w-8 h-8 text-slate-300" />
                  </div>
                  <p className="text-slate-500 font-bold text-lg">No saved sessions yet.</p>
                  <p className="text-slate-400 text-sm mt-1 mb-8">Start revising by uploading your first material!</p>
                  <button 
                    onClick={startStudy}
                    className="px-8 py-3 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-700 transition-all"
                  >
                    Start First Session
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                  {savedSessions.map((session) => (
                    <motion.div
                      key={session.id}
                      layout
                      className="group bg-white p-6 rounded-[2rem] border border-slate-100 shadow-sm hover:shadow-xl hover:border-indigo-100 transition-all cursor-pointer relative overflow-hidden"
                      onClick={() => openSession(session)}
                    >
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirmDeleteId === session.id) {
                            deleteSession(session.id);
                            setConfirmDeleteId(null);
                          } else {
                            setConfirmDeleteId(session.id);
                            setTimeout(() => setConfirmDeleteId(null), 3000);
                          }
                        }}
                        className={cn(
                          "absolute top-4 right-4 w-10 h-10 rounded-full flex items-center justify-center shadow-md border transition-all z-20 active:scale-90",
                          confirmDeleteId === session.id 
                            ? "bg-red-500 text-white border-red-600 animate-pulse" 
                            : "bg-white/90 text-red-500 border-slate-100 hover:bg-red-50 hover:text-red-600"
                        )}
                        title={confirmDeleteId === session.id ? "Click again to confirm" : "Delete Session"}
                      >
                        {confirmDeleteId === session.id ? <X className="w-4 h-4" /> : <Trash2 className="w-4 h-4" />}
                      </button>
                      <div className="relative z-10">
                        <div className="mb-4 text-[10px] font-bold text-slate-400 flex items-center gap-1.5 uppercase tracking-widest">
                          <History className="w-3 h-3" />
                           {session.createdAt?.seconds ? new Date(session.createdAt.seconds * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Recent'}
                        </div>
                        <h4 className="text-xl font-display italic font-black text-slate-900 mb-2 line-clamp-2 leading-tight pr-6">{session.title}</h4>
                        <p className="text-slate-500 text-sm line-clamp-3 leading-relaxed mb-6">
                          {session.summary}
                        </p>
                        <div className="flex items-center justify-between pt-4 border-t border-slate-50">
                          <span className="text-[9px] font-black uppercase text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-lg">
                            {session.quiz?.length || 0} Quiz Questions
                          </span>
                          <ArrowRight className="w-5 h-5 text-slate-300 group-hover:text-indigo-600 transition-colors" />
                        </div>
                      </div>
                      
                      {/* Suble background element */}
                      <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-50/50 rounded-full blur-3xl -mr-16 -mt-16 group-hover:bg-indigo-100/50 transition-colors"></div>
                    </motion.div>
                  ))}
                </div>
              )}
            </motion.div>
          )}

          {page === 'study' && (
            <motion.div key="study">
              {state === 'idle' && (
                <motion.div
                  key="idle"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="text-center py-20"
                >
                  <button 
                    onClick={reset}
                    className="mb-8 flex items-center gap-2 text-slate-500 hover:text-indigo-600 font-bold transition-colors mx-auto"
                  >
                    <ChevronLeft className="w-5 h-5" />
                    Back to Home
                  </button>

                  <div className="max-w-2xl mx-auto space-y-6 md:space-y-8">
                    <h2 className="text-3xl xs:text-4xl md:text-5xl font-display italic font-black text-slate-950">Upload Your Material</h2>
                    <p className="text-slate-500 text-base md:text-lg">Upload textbook pages, lecture slides, or screenshots. The system will handle the rest.</p>
                    
                    <div 
                      onClick={() => fileInputRef.current?.click()}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        const files = Array.from(e.dataTransfer.files);
                        if (files.length > 0) processFiles(files);
                      }}
                      className="group relative cursor-pointer"
                    >
                      <div className="absolute -inset-1 bg-gradient-to-r from-indigo-500 to-purple-500 rounded-2xl blur opacity-25 group-hover:opacity-40 transition duration-1000 group-hover:duration-200"></div>
                      <div className="relative bg-white border-2 border-dashed border-slate-200 rounded-[2rem] p-10 sm:p-20 transition-all hover:border-indigo-400">
                        <div className="flex flex-col items-center">
                          <div className="w-16 h-16 sm:w-24 sm:h-24 bg-indigo-50 rounded-2xl sm:rounded-[2rem] flex items-center justify-center mb-6 group-hover:scale-110 transition-transform group-hover:bg-indigo-600 group-hover:text-white">
                            <Upload className="w-8 h-8 sm:w-10 sm:h-10" />
                          </div>
                          <p className="text-xl sm:text-2xl font-black text-slate-900 mb-2 text-center">Drop your images here</p>
                          <p className="text-slate-500 text-sm sm:text-base">or click to browse your files</p>
                        </div>
                      </div>
                      <input 
                        type="file" 
                        className="hidden" 
                        ref={fileInputRef} 
                        accept="image/*"
                        multiple
                        onChange={handleFileChange}
                      />
                    </div>

                    {/* Integrated Upload Bar */}
                    <div className="pt-4 mx-auto max-w-xl">
                      <div className="bg-white rounded-[2rem] shadow-xl border border-slate-200 p-2 flex items-center gap-3 ring-1 ring-black/5">
                        <button 
                          onClick={() => fileInputRef.current?.click()}
                          className="w-12 h-12 flex items-center justify-center text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-[1.25rem] transition-all shrink-0"
                          title="Add Material"
                        >
                          <Upload className="w-5 h-5" />
                        </button>
                        
                        <div className="flex-1 min-w-0">
                          <input 
                            placeholder="Click here & paste screenshot..."
                            className="w-full bg-transparent border-none focus:ring-0 text-slate-900 placeholder:text-slate-400 font-medium text-sm py-2"
                            onFocus={() => setActivePasteTarget('primary')}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && images.length > 0) handleProcess('both');
                            }}
                          />
                        </div>

                        <div className="pr-1">
                          <div className="w-10 h-10 bg-indigo-50 text-indigo-400 rounded-[1.25rem] flex items-center justify-center">
                            <Sparkles className="w-4 h-4" />
                          </div>
                        </div>
                      </div>
                      <p className="mt-3 text-[10px] text-slate-400 font-bold uppercase tracking-[0.2em]">
                        Pro tip: Just press CTRL+V anywhere to paste
                      </p>
                    </div>
                  </div>
                </motion.div>
              )}

          {state === 'ready' && images.length > 0 && (
            <motion.div
              key="ready"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="max-w-5xl mx-auto"
            >
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-start">
                <div className="space-y-6">
                  <div className="grid grid-cols-2 gap-4">
                    {images.map((img, idx) => (
                      <motion.div 
                        key={idx}
                        layout
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="relative group aspect-[4/3] rounded-2xl overflow-hidden border-4 border-white shadow-lg"
                      >
                        <img src={img} alt={`Material ${idx + 1}`} className="w-full h-full object-cover" />
                        <button 
                          onClick={() => removeImage(idx)}
                          className="absolute top-2 right-2 w-8 h-8 bg-white/90 backdrop-blur shadow rounded-full flex items-center justify-center text-slate-900 opacity-0 group-hover:opacity-100 transition-all hover:bg-white hover:scale-110"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </motion.div>
                    ))}
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="aspect-[4/3] rounded-2xl border-2 border-dashed border-slate-200 flex flex-col items-center justify-center text-slate-400 hover:border-indigo-300 hover:text-indigo-500 hover:bg-indigo-50/50 transition-all"
                    >
                      <Upload className="w-6 h-6 mb-2" />
                      <span className="text-xs font-bold uppercase tracking-wider">Add More</span>
                    </button>
                  </div>

                  <div className="bg-white/50 backdrop-blur p-4 rounded-2xl border border-slate-200">
                    <p className="text-sm text-slate-500 text-center italic">
                      Tip: You can paste (CMD+V) more screenshots directly here.
                    </p>
                  </div>

                  {/* Static Upload Bar */}
                  <div className="pt-2">
                    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-2 flex items-center gap-3">
                      <button 
                        onClick={() => fileInputRef.current?.click()}
                        className="w-10 h-10 flex items-center justify-center text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition-all shrink-0"
                        title="Add Material"
                      >
                        <Upload className="w-4 h-4" />
                      </button>
                      
                      <div className="flex-1 min-w-0">
                        <input 
                          placeholder="Paste more screenshots here..."
                          className="w-full bg-transparent border-none focus:ring-0 text-slate-900 placeholder:text-slate-400 font-medium text-sm py-2"
                          onFocus={() => setActivePasteTarget('primary')}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleProcess('both');
                          }}
                        />
                      </div>

                      <div className="pr-1">
                        <div className="w-8 h-8 bg-indigo-50 text-indigo-400 rounded-lg flex items-center justify-center">
                          <Sparkles className="w-3 h-3" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="text-left space-y-8 lg:sticky lg:top-24">
                  <div>
                    <span className="inline-block px-3 py-1 rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold tracking-wider uppercase mb-4">
                      {images.length} {images.length === 1 ? 'Material' : 'Materials'} Captured
                    </span>
                    <h3 className="text-4xl font-display italic font-black text-slate-950 leading-none mb-4">What should Rivyso do?</h3>
                    <p className="text-slate-500">Transform these materials into your personalized survival guide.</p>
                  </div>

                  <div className="grid grid-cols-1 gap-3 md:gap-4">
                    <button
                      onClick={() => handleProcess('notes')}
                      className="group flex items-center gap-4 sm:gap-6 p-4 sm:p-6 bg-white border border-slate-200 rounded-2xl sm:rounded-3xl text-left hover:border-indigo-500 hover:shadow-xl hover:shadow-indigo-50 transition-all active:scale-[0.98]"
                    >
                      <div className="w-12 h-12 sm:w-14 sm:h-14 bg-indigo-50 rounded-xl sm:rounded-2xl flex items-center justify-center group-hover:bg-indigo-600 group-hover:text-white transition-colors flex-shrink-0">
                        <BookOpen className="w-6 h-6 sm:w-7 sm:h-7" />
                      </div>
                      <div>
                        <p className="font-black text-lg sm:text-xl text-slate-950">Simplify to Notes</p>
                        <p className="text-xs sm:text-sm text-slate-500">Get clean summaries and key concepts</p>
                      </div>
                      <ArrowRight className="ml-auto w-4 h-4 sm:w-5 sm:h-5 text-slate-300 group-hover:text-indigo-600 mr-2 flex-shrink-0" />
                    </button>

                    <button
                      onClick={() => handleProcess('quiz')}
                      className="group flex items-center gap-4 sm:gap-6 p-4 sm:p-6 bg-white border border-slate-200 rounded-2xl sm:rounded-3xl text-left hover:border-purple-500 hover:shadow-xl hover:shadow-purple-50 transition-all active:scale-[0.98]"
                    >
                      <div className="w-12 h-12 sm:w-14 sm:h-14 bg-purple-50 rounded-xl sm:rounded-2xl flex items-center justify-center group-hover:bg-purple-600 group-hover:text-white transition-colors flex-shrink-0">
                        <BrainCircuit className="w-6 h-6 sm:w-7 sm:h-7" />
                      </div>
                      <div>
                        <p className="font-black text-lg sm:text-xl text-slate-950">Create a Quiz</p>
                        <p className="text-xs sm:text-sm text-slate-500">Practice with 5 target questions</p>
                      </div>
                      <ArrowRight className="ml-auto w-4 h-4 sm:w-5 sm:h-5 text-slate-300 group-hover:text-purple-600 mr-2 flex-shrink-0" />
                    </button>

                    <button
                      onClick={() => handleProcess('both')}
                      className="group flex items-center gap-4 sm:gap-6 p-4 sm:p-6 bg-indigo-600 rounded-2xl sm:rounded-3xl text-left hover:bg-indigo-700 hover:shadow-2xl hover:shadow-indigo-200 transition-all active:scale-[0.98]"
                    >
                      <div className="w-12 h-12 sm:w-14 sm:h-14 bg-white/20 rounded-xl sm:rounded-2xl flex items-center justify-center text-white flex-shrink-0">
                        <Sparkles className="w-6 h-6 sm:w-7 sm:h-7" />
                      </div>
                      <div className="text-white">
                        <p className="font-black text-lg sm:text-xl">The Full Works</p>
                        <p className="text-xs sm:text-sm opacity-80">Do both: Summarize AND Quiz</p>
                      </div>
                      <ArrowRight className="ml-auto w-4 h-4 sm:w-5 sm:h-5 text-white/40 group-hover:text-white mr-2 flex-shrink-0" />
                    </button>
                  </div>

                  {/* Reference Style Uploader Section */}
                  <div className="pt-8 border-t border-slate-100">
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <h4 className="text-sm font-black text-slate-900 flex items-center gap-2">
                          <BrainCircuit className="w-4 h-4 text-indigo-600" />
                          Personalize Style (Optional)
                        </h4>
                        <p className="text-[10px] text-slate-400 mt-0.5">Upload screenshots of past exams from your teacher to mimic their specific style of questioning.</p>
                      </div>
                    </div>

                    <div className="space-y-4">
                      {referenceImages.length > 0 && (
                        <div className="flex flex-wrap gap-2 mb-3">
                          {referenceImages.map((img, idx) => (
                            <div key={idx} className="relative group/ref w-16 h-16 rounded-xl overflow-hidden border border-slate-200">
                              <img src={img} className="w-full h-full object-cover" alt="" />
                              <button 
                                onClick={() => removeReferenceImage(idx)}
                                className="absolute inset-0 bg-red-500/80 items-center justify-center hidden group-hover/ref:flex text-white transition-all"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      
                      <div className="flex items-center gap-2 p-2 bg-white border border-slate-200 rounded-2xl shadow-sm focus-within:border-indigo-300 focus-within:ring-4 focus-within:ring-indigo-50/50 transition-all">
                        <button 
                          onClick={() => {
                             const el = document.getElementById('ref-upload-input');
                             if (el) el.click();
                          }}
                          className="p-2 bg-slate-50 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition-all"
                        >
                          <Upload className="w-4 h-4" />
                        </button>
                        
                        <div className="flex-1 min-w-0">
                          <input 
                            placeholder="Paste teacher's past exam styles here..."
                            className="w-full bg-transparent border-none focus:ring-0 text-slate-900 placeholder:text-slate-400 font-medium text-xs py-2"
                            onFocus={() => setActivePasteTarget('reference')}
                          />
                        </div>

                        <div className="p-2 bg-indigo-50 rounded-xl mr-1">
                           <Sparkles className="w-4 h-4 text-indigo-500" />
                        </div>
                        
                        <input 
                          id="ref-upload-input"
                          type="file" 
                          multiple 
                          accept="image/*" 
                          className="hidden" 
                          onChange={handleReferenceFileChange}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {state === 'processing' && (
            <motion.div
              key="processing"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center py-20"
            >
              <div className="relative mb-8">
                <div className="absolute inset-0 bg-indigo-200 rounded-full blur-xl animate-pulse"></div>
                <Loader2 className="w-16 h-16 text-indigo-600 animate-spin relative" />
              </div>
              <h3 className="text-2xl font-bold text-slate-900 mb-2">Analyzing...</h3>
              <p className="text-slate-500 animate-pulse">Consulting the Study Guru</p>
            </motion.div>
          )}

          {state === 'error' && (
            <motion.div
              key="error"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="bg-red-50 border border-red-100 p-8 rounded-2xl text-center"
            >
              <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <X className="w-8 h-8 text-red-600" />
              </div>
              <h3 className="text-xl font-bold text-red-900 mb-2">Something went wrong</h3>
              <p className="text-red-700 mb-6">{error}</p>
              <button 
                onClick={reset}
                className="bg-red-600 text-white px-6 py-2 rounded-xl font-bold hover:bg-red-700 transition-colors"
              >
                Try Again
              </button>
            </motion.div>
          )}

          {state === 'result' && result && (
                <motion.div
                  key="result"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="space-y-8"
                >
                  <div className="flex flex-col sm:flex-row items-center justify-between gap-6 mb-8 mt-2">
                    <button 
                      onClick={() => setPage('sessions')}
                      className="flex items-center gap-2 text-slate-500 hover:text-indigo-600 font-bold transition-colors self-start"
                    >
                      <ChevronLeft className="w-5 h-5" />
                      Back to Library
                    </button>
                      <div className="flex flex-wrap items-center justify-center sm:justify-end gap-3 w-full sm:w-auto">
                        {/* Download Section */}
                        <div className="flex items-center gap-1 bg-white p-1 rounded-2xl border border-slate-200 shadow-sm">
                          {/* Desktop Only: Full Visibility */}
                          <div className="hidden xl:flex items-center gap-1">
                            <button 
                              onClick={() => downloadResult('notes')}
                              className="px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 hover:text-indigo-600 rounded-xl transition-all"
                            >
                              Download Notes
                            </button>
                            <button 
                              onClick={() => downloadResult('quiz')}
                              className="px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 hover:text-indigo-600 rounded-xl transition-all"
                            >
                              Download Quiz
                            </button>
                          </div>
                          
                          <button 
                             onClick={() => downloadResult('both')}
                             className="flex items-center gap-2 px-4 py-2 bg-indigo-50 text-indigo-700 rounded-xl text-sm font-bold hover:bg-indigo-100 transition-all"
                             title="Download Full Guide"
                          >
                            <Download className="w-4 h-4" />
                            <span className="inline">Full PDF</span>
                          </button>
                          
                          {/* Dropdown for XL-hidden options on LG/MD */}
                          <div className="relative xl:hidden">
                            <button 
                              className="p-2 h-full text-slate-400 hover:text-indigo-600 transition-colors"
                              onClick={() => {
                                setIsDownloadMenuOpen(!isDownloadMenuOpen);
                                setIsShareMenuOpen(false);
                              }}
                            >
                              <ChevronDown className={cn("w-4 h-4 transition-transform", isDownloadMenuOpen && "rotate-180")} />
                            </button>
                            
                            <AnimatePresence>
                              {isDownloadMenuOpen && (
                                <>
                                  <div className="fixed inset-0 z-[60]" onClick={() => setIsDownloadMenuOpen(false)} />
                                  <motion.div
                                    initial={{ opacity: 0, y: 10, scale: 0.95 }}
                                    animate={{ opacity: 1, y: 0, scale: 1 }}
                                    exit={{ opacity: 0, y: 10, scale: 0.95 }}
                                    className="absolute top-full right-0 mt-3 w-48 bg-white rounded-2xl shadow-2xl border border-slate-100 py-2 z-[70] overflow-hidden"
                                  >
                                    {[
                                      { id: 'notes', label: 'Study Notes', icon: <BookOpen className="w-4 h-4" /> },
                                      { id: 'quiz', label: 'Practice Quiz', icon: <BrainCircuit className="w-4 h-4" /> },
                                      { id: 'both', label: 'Complete PDF (Full)', icon: <Sparkles className="w-4 h-4" /> },
                                    ].map((item) => (
                                      <button
                                        key={item.id}
                                        onClick={() => downloadResult(item.id as any)}
                                        className="w-full flex items-center gap-3 px-4 py-3 text-sm font-bold text-slate-600 hover:bg-indigo-50 hover:text-indigo-600 transition-colors text-left"
                                      >
                                        {item.icon}
                                        {item.label}
                                      </button>
                                    ))}
                                  </motion.div>
                                </>
                              )}
                            </AnimatePresence>
                          </div>
                        </div>

                        {/* Share Section */}
                        <div className="flex items-center gap-1 bg-white p-1 rounded-2xl border border-slate-200 shadow-sm">
                           {/* Desktop Only: Full Visibility */}
                           <div className="hidden xl:flex items-center gap-1">
                            <button 
                              onClick={() => handleShare('notes')}
                              className="px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 hover:text-indigo-600 rounded-xl transition-all"
                            >
                              Share Notes
                            </button>
                            <button 
                              onClick={() => handleShare('quiz')}
                              className="px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 hover:text-indigo-600 rounded-xl transition-all"
                            >
                              Share Quiz
                            </button>
                          </div>

                          <button 
                             onClick={() => handleShare('both')}
                             className="flex items-center gap-2 px-4 py-2 bg-slate-50 text-slate-700 rounded-xl text-sm font-bold hover:bg-slate-100 transition-all"
                             title="Share All"
                          >
                            <Share2 className="w-4 h-4 text-indigo-600" />
                            <span className="inline">Share</span>
                          </button>
                          
                          <div className="relative xl:hidden">
                            <button 
                              className="p-2 h-full text-slate-400 hover:text-indigo-600 transition-colors"
                              onClick={() => {
                                setIsShareMenuOpen(!isShareMenuOpen);
                                setIsDownloadMenuOpen(false);
                              }}
                            >
                              <ChevronDown className={cn("w-4 h-4 transition-transform", isShareMenuOpen && "rotate-180")} />
                            </button>
                            
                            <AnimatePresence>
                              {isShareMenuOpen && (
                                <>
                                  <div className="fixed inset-0 z-[60]" onClick={() => setIsShareMenuOpen(false)} />
                                  <motion.div
                                    initial={{ opacity: 0, y: 10, scale: 0.95 }}
                                    animate={{ opacity: 1, y: 0, scale: 1 }}
                                    exit={{ opacity: 0, y: 10, scale: 0.95 }}
                                    className="absolute top-full right-0 mt-3 w-48 bg-white rounded-2xl shadow-2xl border border-slate-100 py-2 z-[70] overflow-hidden"
                                  >
                                    {[
                                      { id: 'notes', label: 'Share Notes', icon: <BookOpen className="w-4 h-4" /> },
                                      { id: 'quiz', label: 'Share Quiz', icon: <BrainCircuit className="w-4 h-4" /> },
                                      { id: 'both', label: 'Share Everything', icon: <Sparkles className="w-4 h-4" /> },
                                    ].map((item) => (
                                      <button
                                        key={item.id}
                                        onClick={() => handleShare(item.id as any)}
                                        className="w-full flex items-center gap-3 px-4 py-3 text-sm font-bold text-slate-600 hover:bg-indigo-50 hover:text-indigo-600 transition-colors text-left"
                                      >
                                        {item.icon}
                                        {item.label}
                                      </button>
                                    ))}
                                  </motion.div>
                                </>
                              )}
                            </AnimatePresence>
                          </div>
                        </div>

                      {!user && (
                        <button 
                          onClick={() => setPage('auth')}
                          className="flex items-center gap-2 px-3 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-bold hover:bg-indigo-700 transition-all active:scale-95 shadow-lg shadow-indigo-100"
                        >
                          <Save className="w-4 h-4" />
                          <span className="hidden xs:inline">Save Session</span>
                        </button>
                      )}

                      <button 
                        onClick={reset}
                        className="flex items-center gap-2 px-3 py-2.5 bg-slate-100 text-slate-600 rounded-xl text-sm font-bold hover:bg-slate-200 transition-all active:scale-95 border border-slate-200"
                        title="Start New Session"
                      >
                        <RefreshCcw className="w-4 h-4" />
                        <span className="hidden xs:inline">New Session</span>
                      </button>
                    </div>
                  </div>

                  {/* Result Section Selector */}
                  <div className="flex flex-row gap-2 w-full max-w-md mx-auto sticky top-20 z-40 bg-white/80 backdrop-blur-md p-1.5 rounded-2xl border border-slate-200 shadow-lg">
                    {(result.notes.title || result.notes.summary) && (
                      <button
                        onClick={() => setView('notes')}
                        className={cn(
                          "flex-1 flex items-center justify-center gap-2 sm:gap-3 px-3 sm:px-6 py-3 sm:py-4 rounded-xl text-xs sm:text-sm font-bold transition-all",
                          view === 'notes' 
                            ? "bg-indigo-600 text-white shadow-md shadow-indigo-100" 
                            : "text-slate-500 hover:text-indigo-600"
                        )}
                      >
                        <BookOpen className="w-4 h-4 sm:w-5 sm:h-5" />
                        Notes
                      </button>
                    )}
                    {result.quiz && result.quiz.length > 0 && (
                      <button
                        onClick={() => setView('quiz')}
                        className={cn(
                          "flex-1 flex items-center justify-center gap-2 sm:gap-3 px-3 sm:px-6 py-3 sm:py-4 rounded-xl text-xs sm:text-sm font-bold transition-all",
                          view === 'quiz' 
                            ? "bg-indigo-600 text-white shadow-md shadow-indigo-100" 
                            : "text-slate-500 hover:text-indigo-600"
                        )}
                      >
                        <BrainCircuit className="w-4 h-4 sm:w-5 sm:h-5" />
                        Quiz
                      </button>
                    )}
                  </div>

              {/* View Rendering */}
              <div className="mt-8">
                {view === 'notes' ? (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                    <div className="md:col-span-2 space-y-8">
                      <div className="bg-white p-6 sm:p-8 rounded-3xl border border-slate-200 shadow-sm">
                        <h2 className="text-2xl sm:text-3xl font-display italic font-black text-slate-950 mb-4">{result.notes.title}</h2>
                        <div className="markdown-content text-slate-700 text-sm sm:text-base">
                          <ReactMarkdown>{result.notes.detailedContent}</ReactMarkdown>
                        </div>
                      </div>
                    </div>
                    <div className="space-y-6">
                      <div className="bg-indigo-600 p-6 rounded-3xl text-white shadow-xl shadow-indigo-200">
                        <h4 className="font-bold mb-3 flex items-center gap-2">
                          <Sparkles className="w-4 h-4" />
                          The TL;DR
                        </h4>
                        <p className="text-indigo-50 leading-relaxed text-sm">
                          {result.notes.summary}
                        </p>
                      </div>
                      <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
                        <h4 className="font-bold text-slate-900 mb-4">Key Takeaways</h4>
                        <ul className="space-y-3">
                          {result.notes.keyPoints.map((point, i) => (
                            <motion.li 
                              key={i}
                              initial={{ opacity: 0, x: -10 }}
                              animate={{ opacity: 1, x: 0 }}
                              transition={{ delay: i * 0.1 }}
                              className="flex gap-3 text-sm text-slate-600"
                            >
                              <div className="mt-1 flex-shrink-0 w-2 h-2 rounded-full bg-indigo-400" />
                              {point}
                            </motion.li>
                          ))}
                        </ul>
                      </div>
                      {images.length > 0 && (
                        <div className="space-y-4">
                          <h4 className="font-bold text-slate-900 px-1 italic">Source Material</h4>
                          <div className="grid grid-cols-2 gap-3">
                            {images.map((img, idx) => (
                              <div key={idx} className="group relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm hover:shadow-md transition-shadow aspect-video">
                                <img src={img} alt={`Material ${idx + 1}`} className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" />
                                <div className="absolute inset-0 flex items-end p-2 bg-gradient-to-t from-black/60 via-transparent to-transparent">
                                  <span className="text-[8px] uppercase tracking-widest font-bold text-white/90">Page {idx + 1}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="max-w-2xl mx-auto space-y-6 pb-20">
                    <div className="text-center mb-8 px-4">
                      <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 mb-2 font-display italic">Check your knowledge</h2>
                      <p className="text-slate-500 text-sm">Practice questions generated from your material</p>
                    </div>
                    {result.quiz.map((q, idx) => (
                      <motion.div
                        key={idx}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: idx * 0.1 }}
                        className="bg-white p-6 sm:p-8 rounded-3xl border border-slate-200 shadow-sm mx-1"
                      >
                        <p className="font-bold text-base sm:text-lg text-slate-900 mb-6">
                          <span className="text-indigo-600 mr-2">{idx + 1}.</span>
                          {q.question}
                        </p>
                        <div className="space-y-3">
                          {q.options.map((option, oIdx) => {
                            const isSelected = quizScores[idx] === option;
                            const isCorrect = option === q.correctAnswer;
                            const hasAnswered = !!quizScores[idx];
                            
                            return (
                              <button
                                key={oIdx}
                                disabled={hasAnswered}
                                onClick={() => setQuizScores(prev => ({ ...prev, [idx]: option }))}
                                className={cn(
                                  "w-full text-left p-4 rounded-xl border-2 transition-all flex items-center justify-between",
                                  !hasAnswered ? "border-slate-100 hover:border-indigo-100 hover:bg-slate-50" : "cursor-default",
                                  hasAnswered && isCorrect ? "bg-emerald-50 border-emerald-200 text-emerald-900" : "",
                                  hasAnswered && isSelected && !isCorrect ? "bg-red-50 border-red-200 text-red-900" : "",
                                  hasAnswered && !isSelected && isCorrect ? "bg-emerald-50/50 border-emerald-100/50 opacity-80" : "",
                                  hasAnswered && !isSelected && !isCorrect ? "opacity-30 border-slate-50" : ""
                                )}
                              >
                                <span className="text-sm font-medium">{option}</span>
                                {hasAnswered && isCorrect && <Check className="w-5 h-5 text-emerald-600" />}
                                {hasAnswered && isSelected && !isCorrect && <X className="w-5 h-5 text-red-600" />}
                              </button>
                            );
                          })}
                        </div>
                        <AnimatePresence>
                          {quizScores[idx] && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              className="mt-6 pt-6 border-t border-slate-100"
                            >
                              <div className="flex gap-4 items-start bg-slate-50 p-4 rounded-xl">
                                <div className={cn(
                                  "w-8 h-8 rounded-full flex items-center justify-center shrink-0 shadow-sm",
                                  quizScores[idx] === q.correctAnswer ? "bg-emerald-500 text-white" : "bg-red-500 text-white"
                                )}>
                                  {quizScores[idx] === q.correctAnswer ? <Check size={16} /> : <X size={16} />}
                                </div>
                                <div>
                                  <span className="font-bold text-slate-900 text-sm block mb-1">Answer Profile</span>
                                  <p className="text-sm text-slate-600 leading-relaxed italic">
                                    {q.explanation}
                                  </p>
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    ))}
                    {Object.keys(quizScores).length === result.quiz.length && (
                      <motion.div
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="bg-indigo-950 p-8 rounded-[2rem] text-center text-white shadow-2xl shadow-indigo-200"
                      >
                        <h3 className="text-3xl font-display italic font-black mb-2">Quiz Complete!</h3>
                        <p className="text-indigo-300 mb-8 font-medium">
                          You scored {Object.entries(quizScores).filter(([idx, answer]) => answer === result.quiz[parseInt(idx)].correctAnswer).length} / {result.quiz.length}
                        </p>
                        <button 
                          onClick={reset}
                          className="bg-white text-indigo-950 px-8 py-4 rounded-2xl font-bold hover:bg-slate-50 transition-all flex items-center gap-2 mx-auto active:scale-95"
                        >
                          Upload another chapter
                          <ArrowRight className="w-5 h-5" />
                        </button>
                      </motion.div>
                    )}
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
      </main>

      {/* Persistence Card for Guest */}
      <AnimatePresence>
        {!user && state === 'result' && (
          <motion.div 
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 20, opacity: 0 }}
            className="fixed bottom-24 left-4 right-4 z-[100] md:left-auto md:right-8 md:w-96"
          >
            <div className="bg-indigo-600 rounded-2xl p-6 shadow-2xl text-white relative overflow-hidden">
              <div className="relative z-10">
                <h4 className="font-black text-lg mb-2 flex items-center gap-2">
                  <Save className="w-5 h-5" />
                  Save this session?
                </h4>
                <p className="text-indigo-100 text-sm mb-4 leading-relaxed">
                  Sign up now to save these notes to your permanent library and access them anywhere.
                </p>
                <div className="flex gap-3">
                  <button 
                    onClick={() => setPage('auth')}
                    className="flex-1 bg-white text-indigo-600 py-2.5 rounded-xl text-sm font-bold hover:bg-slate-50 transition-colors"
                  >
                    Join Rivyso Free
                  </button>
                  <button 
                    onClick={() => setState('idle')} // Dismiss hint
                    className="px-4 py-2.5 bg-indigo-500 text-white rounded-xl text-sm font-bold hover:bg-indigo-400 transition-colors"
                  >
                    Not now
                  </button>
                </div>
              </div>
              {/* Decorative circle */}
              <div className="absolute -bottom-10 -right-10 w-40 h-40 bg-white/10 rounded-full blur-2xl" />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Decorative background stripes */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none -z-10">
        <div className="absolute top-0 right-0 w-1/3 h-screen bg-indigo-50/20 skew-x-12 transform origin-top"></div>
        <div className="absolute top-0 left-0 w-1/4 h-screen bg-purple-50/20 -skew-x-12 transform origin-top"></div>
      </div>
    </div>
  );
}

