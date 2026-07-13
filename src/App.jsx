import React from 'react';
import { createClient } from '@supabase/supabase-js';
import './index.css';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

function localTodayIso() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

// Adds a hover style on top of a base style object without needing React state:
// applies `hover` styles directly to the DOM node on mouseenter and restores `base` on mouseleave.
function hoverStyle(base, hover) {
  return {
    style: base,
    onMouseEnter: (e) => Object.assign(e.currentTarget.style, hover),
    onMouseLeave: (e) => Object.assign(e.currentTarget.style, base),
  };
}

// ---- Supabase cloud storage ----
// I dati dell'app vengono salvati in Supabase nella tabella user_finance_store.
// Ogni utente autenticato legge e aggiorna solo il proprio record grazie alle policy RLS.
class App extends React.Component {
  constructor(props){
    super(props);
    const startView = ['dashboard','budget','transactions','accounts','categories'].includes(this.props.startView) ? this.props.startView : 'dashboard';
    const isMobile = (typeof window !== 'undefined') ? window.innerWidth < 860 : false;
    const rememberedUser = (typeof window !== 'undefined') ? (localStorage.getItem('fp_remember_user') || '') : '';
    const privacyMode = (typeof window !== 'undefined') ? (localStorage.getItem('fp_privacy') === '1') : false;
    this.store = null;
    this._supabaseUser = null;
    this.state = {
      view: startView,
      month: localTodayIso().slice(0, 7),
      isMobile: isMobile,
      drawerOpen: false,
      mobileMoreOpen: false,
      collapsed: false,
      auth: { loggedIn:false, busy:false, username: rememberedUser, password:'', remember: !!rememberedUser, error:'', mode:'login', info:'', newPassword:'', newPassword2:'' },
      filters: { from:'', to:'', accountId:'', categoryId:'', type:'', search:'' },
      dash: { tab:'networth', range:'6m', accountId:'', groupId:'', categoryId:'', customFrom:'', customTo:'' },
      modal: { open:false, kind:null, mode:'create', data:{} },
      accounts: [],
      transactions: [],
      categories: [],
      groups: [],
      budgets: [],
      categoryNotes: [],
      budgetEdits: {},
      collapsedGroups: {},
      theme: 'dark',
      selectedTxnIds: {},
      budgetStickyH: 0,
      budgetKeypad: null,
      detailCategoryId: null,
      statsPopoverOpen: false,
      noteEdits: {},
      targetEditor: null,
      moveMoney: null,
      privacyMode,
    };
    this.accountTypes = [
      ['Current Account','Conto corrente'],['Card','Carta'],['Deposit','Deposito'],
      ['Broker','Broker'],['Pension Fund','Fondo pensione'],['Cash','Contanti'],
      ['Crypto','Crypto'],['Other','Altro']
    ];
    this.monthNames = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
    this.monthAbbrArr = ['Gen','Feb','Mar','Apr','Mag','Giu','Lug','Ago','Set','Ott','Nov','Dic'];
    this.budgetInputRefs = {};
    this.budgetStickyRef = React.createRef();
  }

  componentDidMount(){
    this._onResize = () => {
      const m = window.innerWidth < 860;
      if (m !== this.state.isMobile) this.setState({ isMobile:m, drawerOpen:false });
    };
    window.addEventListener('resize', this._onResize);
    this._onBudgetFocus = (e) => { if (this.isBudgetDomInput(e.target) && e.target.select) e.target.select(); };
    window.addEventListener('focusin', this._onBudgetFocus);
    this._onKey = (e) => {
      if (this.isBudgetDomInput(e.target) && ['Enter','Tab','ArrowDown','ArrowUp'].includes(e.key)){
        e.preventDefault();
        const delta = (e.key==='ArrowUp' || (e.key==='Tab' && e.shiftKey)) ? -1 : 1;
        this.moveBudgetDomFocus(e.target, delta);
        return;
      }
      if (e.key === 'Escape' && this.state.modal.open) this.closeModal();
    };
    window.addEventListener('keydown', this._onKey);
    this.measureBudgetSticky();
    // Quando l'utente apre il link di reset ricevuto via email, Supabase apre
    // automaticamente una sessione "di recupero" e notifica questo evento:
    // passiamo alla schermata "imposta nuova password" invece che al login.
    const { data: authListener } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY'){
        this.setState({ auth: Object.assign({}, this.state.auth, { mode:'reset', error:'', info:'' }) });
      }
    });
    this._authListener = authListener;
  }
  measureBudgetSticky(){
    const el = this.budgetStickyRef.current;
    if (this.state.view === 'budget' && el){
      const h = el.offsetHeight;
      if (h && h !== this.state.budgetStickyH) this.setState({ budgetStickyH: h });
      // Un ResizeObserver (non solo una misura una tantum) è necessario perché questo
      // blocco può cambiare altezza per motivi che non passano da componentDidUpdate:
      // in particolare il caricamento asincrono dei font web (Hanken Grotesk/JetBrains
      // Mono) causa un reflow del testo DOPO la prima misura, disallineando per sempre
      // le intestazioni agganciate sotto se non la si rileva e corregge.
      if (typeof ResizeObserver !== 'undefined' && this._budgetStickyRO_target !== el){
        if (this._budgetStickyRO) this._budgetStickyRO.disconnect();
        this._budgetStickyRO = new ResizeObserver(() => this.measureBudgetSticky());
        this._budgetStickyRO.observe(el);
        this._budgetStickyRO_target = el;
      }
    }
  }
  componentWillUnmount(){
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('focusin', this._onBudgetFocus);
    window.removeEventListener('keydown', this._onKey);
    if (this._budgetStickyRO) this._budgetStickyRO.disconnect();
    if (this._authListener) this._authListener.subscription.unsubscribe();
  }
  componentDidUpdate(){
    // Misura l'altezza reale del blocco sticky "mese + pronto da assegnare" del
    // Budget: cambia (es. quando compare l'avviso di sforamento) e le righe sotto
    // (intestazione tabella, intestazioni di gruppo) devono agganciarsi subito
    // sotto, senza sovrapporsi né lasciare vuoti.
    this.measureBudgetSticky();
  }

  /* ---------- ABSTRACT DATA STORE (Sheets-like tables, swappable) ---------- */
  createStoreFromDb(db, options = {}){
    const self = this;
    const saveOnInit = options.saveOnInit === true;
    let saveChain = Promise.resolve();
    const save = () => {
      // db is mutated synchronously before save() is called. Chaining keeps
      // writes ordered when several saves happen in quick succession.
      const snapshot = JSON.parse(JSON.stringify(db));
      saveChain = saveChain
        .then(async () => {
          if (!self._supabaseUser) return;
          const { error } = await supabase
            .from('user_finance_store')
            .upsert({
              user_id: self._supabaseUser.id,
              data: snapshot,
              updated_at: new Date().toISOString(),
            }, { onConflict: 'user_id' });
          if (error) throw error;
        })
        .catch((e) => { console.error('Salvataggio cloud non riuscito:', e); });
    };
    if (saveOnInit) save();
    const uid = (p) => p + '_' + Math.random().toString(36).slice(2,9);
    const api = {
      all: (sheet) => (db[sheet] || []).slice(),
      get: (sheet, id) => (db[sheet] || []).find(r => r.id === id),
      create: (sheet, obj) => { const row = Object.assign({}, obj, { id: obj.id || uid(sheet.toLowerCase()) }); db[sheet] = (db[sheet]||[]).concat([row]); save(); return row; },
      update: (sheet, id, patch) => { db[sheet] = (db[sheet]||[]).map(r => r.id===id ? Object.assign({}, r, patch) : r); save(); return api.get(sheet,id); },
      remove: (sheet, id) => { db[sheet] = (db[sheet]||[]).filter(r => r.id !== id); save(); },
      reorder: (sheet, ids) => {
        const order = {};
        ids.forEach((id, idx) => { order[id] = idx; });
        db[sheet] = (db[sheet]||[])
          .slice()
          .sort((a,b) => (order[a.id] ?? 999999) - (order[b.id] ?? 999999))
          .map((r, idx) => Object.assign({}, r, { sortOrder: idx }));
        save();
      },
      upsertBudget: (month, categoryId, assigned) => {
        const ex = (db.Budgets||[]).find(b => b.month===month && b.categoryId===categoryId);
        if (ex) return api.update('Budgets', ex.id, { assigned });
        return api.create('Budgets', { month, categoryId, assigned });
      },
      reset: () => { db = self.seed(); save(); },
      clearBudgets: () => { db.Budgets = []; save(); }
    };
    return api;
  }

  // Carica dal cloud i dati dell'utente autenticato oppure inizializza i dati demo.
  async loadOrInitStore(){
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) throw userError || new Error('Utente non autenticato');
    this._supabaseUser = userData.user;

    const { data: row, error } = await supabase
      .from('user_finance_store')
      .select('data')
      .eq('user_id', userData.user.id)
      .maybeSingle();

    if (error) throw error;

    const hasCloudRow = !!(row && row.data);
    const db = hasCloudRow ? row.data : this.seed();

    this.store = this.createStoreFromDb(db, { saveOnInit: !hasCloudRow });
    return db;
  }

  seed(){
    const A = [
      { id:'acc_cc', name:'Conto Corrente', bank:'Intesa Sanpaolo', type:'Current Account', initialBalance:3200, onBudget:true },
      { id:'acc_rev', name:'Revolut', bank:'Revolut', type:'Card', initialBalance:450, onBudget:true },
      { id:'acc_dep', name:'Deposito Findomestic', bank:'Findomestic', type:'Deposit', initialBalance:8000, onBudget:true },
      { id:'acc_cash', name:'Contanti', bank:'—', type:'Cash', initialBalance:120, onBudget:true },
      { id:'acc_broker', name:'Broker Directa', bank:'Directa', type:'Broker', initialBalance:5400, onBudget:false },
      { id:'acc_pens', name:'Fondo Pensione', bank:'Amundi', type:'Pension Fund', initialBalance:12500, onBudget:false },
    ];
    const C = [
      { id:'cat_stip', name:'Stipendio', type:'Income', group:'Entrate', target:0 },
      { id:'cat_extra', name:'Entrate extra', type:'Income', group:'Entrate', target:0 },
      { id:'cat_rimb', name:'Rimborsi', type:'Income', group:'Entrate', target:0 },
      { id:'cat_casa', name:'Casa e affitto', type:'Expense', group:'Obblighi fissi', target:850, targetType:'monthly', targetDay:1, targetRepeat:true },
      { id:'cat_boll', name:'Bollette', type:'Expense', group:'Obblighi fissi', target:140, targetType:'monthly', targetDay:1, targetRepeat:true },
      { id:'cat_alim', name:'Spesa alimentare', type:'Expense', group:'Spese quotidiane', target:350, targetType:'monthly', targetDay:1, targetRepeat:true },
      { id:'cat_trasp', name:'Trasporti', type:'Expense', group:'Spese quotidiane', target:120, targetType:'monthly', targetDay:1, targetRepeat:true },
      { id:'cat_rist', name:'Ristoranti', type:'Expense', group:'Qualità della vita', target:100, targetType:'monthly', targetDay:1, targetRepeat:true },
      { id:'cat_svago', name:'Svago', type:'Expense', group:'Qualità della vita', target:80, targetType:'monthly', targetDay:1, targetRepeat:true },
      { id:'cat_shop', name:'Shopping', type:'Expense', group:'Qualità della vita', target:100, targetType:'monthly', targetDay:1, targetRepeat:true },
      { id:'cat_abb', name:'Abbonamenti', type:'Expense', group:'Abbonamenti & Salute', target:40, targetType:'monthly', targetDay:1, targetRepeat:true },
      { id:'cat_salute', name:'Salute', type:'Expense', group:'Abbonamenti & Salute', target:60, targetType:'monthly', targetDay:1, targetRepeat:true },
    ];
    const T = [
      { id:'t01', date:'2026-07-01', description:'Stipendio luglio', accountId:'acc_cc', type:'Income', categoryId:'cat_stip', amount:2600, notes:'', cleared:'reconciled', reconciled:true },
      { id:'t02', date:'2026-07-01', description:'Affitto', accountId:'acc_cc', type:'Expense', categoryId:'cat_casa', amount:850, notes:'', cleared:'reconciled', reconciled:true },
      { id:'t03', date:'2026-07-02', description:'Esselunga', accountId:'acc_rev', type:'Expense', categoryId:'cat_alim', amount:76.40, notes:'Spesa settimanale', cleared:'reconciled', reconciled:true },
      { id:'t04', date:'2026-07-03', description:'Rimborso trasferta', accountId:'acc_cc', type:'Income', categoryId:'cat_rimb', amount:85, notes:'', cleared:'cleared', reconciled:false },
      { id:'t05', date:'2026-07-04', description:'Benzina', accountId:'acc_cc', type:'Expense', categoryId:'cat_trasp', amount:55, notes:'', cleared:'reconciled', reconciled:true },
      { id:'t06', date:'2026-07-05', description:'Bolletta Enel', accountId:'acc_cc', type:'Expense', categoryId:'cat_boll', amount:62.30, notes:'', cleared:'uncleared', reconciled:false },
      { id:'t07', date:'2026-07-05', description:'Giroconto risparmio', accountId:'acc_cc', type:'Transfer', toAccountId:'acc_dep', categoryId:'', amount:500, notes:'', cleared:'reconciled', reconciled:true },
      { id:'t08', date:'2026-07-06', description:'Cena fuori', accountId:'acc_rev', type:'Expense', categoryId:'cat_rist', amount:43.50, notes:'', cleared:'reconciled', reconciled:true },
      { id:'t09', date:'2026-07-06', description:'PAC investimento', accountId:'acc_cc', type:'Transfer', toAccountId:'acc_broker', categoryId:'', amount:300, notes:'ETF World', cleared:'reconciled', reconciled:true },
      { id:'t10', date:'2026-07-08', description:'Netflix', accountId:'acc_rev', type:'Expense', categoryId:'cat_abb', amount:12.99, notes:'', cleared:'reconciled', reconciled:true },
      { id:'t11', date:'2026-07-09', description:'Spotify', accountId:'acc_rev', type:'Expense', categoryId:'cat_abb', amount:9.99, notes:'', cleared:'reconciled', reconciled:true },
      { id:'t12', date:'2026-07-10', description:'Coop', accountId:'acc_rev', type:'Expense', categoryId:'cat_alim', amount:51.20, notes:'', cleared:'cleared', reconciled:false },
      { id:'t13', date:'2026-07-12', description:'Farmacia', accountId:'acc_cash', type:'Expense', categoryId:'cat_salute', amount:18.50, notes:'', cleared:'reconciled', reconciled:true },
      { id:'t14', date:'2026-07-14', description:'Cinema', accountId:'acc_cash', type:'Expense', categoryId:'cat_svago', amount:22, notes:'', cleared:'reconciled', reconciled:true },
      { id:'t15', date:'2026-07-15', description:'Amazon', accountId:'acc_rev', type:'Expense', categoryId:'cat_shop', amount:34.90, notes:'Accessori', cleared:'cleared', reconciled:false },
      { id:'t16', date:'2026-06-01', description:'Stipendio giugno', accountId:'acc_cc', type:'Income', categoryId:'cat_stip', amount:2600, notes:'', cleared:'reconciled', reconciled:true },
      { id:'t17', date:'2026-06-28', description:'Esselunga', accountId:'acc_rev', type:'Expense', categoryId:'cat_alim', amount:82, notes:'', cleared:'reconciled', reconciled:true },
      { id:'t18', date:'2026-06-15', description:'Bolletta gas', accountId:'acc_cc', type:'Expense', categoryId:'cat_boll', amount:71.10, notes:'', cleared:'reconciled', reconciled:true },
    ];
    const B = [
      ['cat_alim',350],['cat_casa',850],['cat_trasp',120],['cat_boll',140],
      ['cat_rist',100],['cat_svago',80],['cat_salute',60],['cat_abb',40],['cat_shop',100]
    ].map((x,i) => ({ id:'b'+i, month:'2026-07', categoryId:x[0], assigned:x[1] }));
    const S = [{ id:'settings', currency:'EUR', locale:'it-IT', theme:'dark' }];
    const G = ['Obblighi fissi','Spese quotidiane','Qualità della vita','Abbonamenti & Salute'].map((n,i)=>({ id:'grp'+i, name:n }));
    return { Accounts:A, Transactions:T, Categories:C, Groups:G, Budgets:B, Settings:S, CategoryNotes:[] };
  }

  refresh(){
    const s = this.store;
    this.setState({ accounts:s.all('Accounts'), transactions:s.all('Transactions'), categories:s.all('Categories'), groups:s.all('Groups'), budgets:s.all('Budgets'), categoryNotes:s.all('CategoryNotes') });
  }

  /* ---------- helpers ---------- */
  fmtEur(n){ return new Intl.NumberFormat('it-IT',{ style:'currency', currency:'EUR' }).format(n || 0); }
  fmtDate(iso){ if(!iso) return ''; const p = iso.split('-'); return p[2]+'/'+p[1]+'/'+p[0].slice(2); }
  monthLabel(ym){ const p = ym.split('-'); return this.monthNames[parseInt(p[1],10)-1] + ' ' + p[0]; }
  addMonth(ym, delta){ const p = ym.split('-'); let y = parseInt(p[0],10); let m = parseInt(p[1],10)-1+delta; y += Math.floor(m/12); m = ((m%12)+12)%12; return y + '-' + String(m+1).padStart(2,'0'); }
  normalizeNumText(v){
    const raw = String(v ?? '').trim();
    if(!raw) return '';
    const sign = raw.indexOf('-') > -1 ? '-' : '';
    const s = raw.replace(/\s/g,'').replace(/[^0-9.,]/g,'');
    if(!s) return '';
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    const decimalSep = lastComma > lastDot ? ',' : (lastDot > lastComma ? '.' : '');
    if(decimalSep){
      const decPos = s.lastIndexOf(decimalSep);
      const decimals = s.slice(decPos + 1);
      if(decimals.length > 0 && decimals.length <= 2){
        const ints = s.slice(0, decPos).replace(/[.,]/g,'') || '0';
        return sign + ints + '.' + decimals;
      }
    }
    return sign + s.replace(/[.,]/g,'');
  }
  parseNum(v){
    if(typeof v === 'number') return Number.isFinite(v) ? v : 0;
    const n = Number.parseFloat(this.normalizeNumText(v));
    return Number.isFinite(n) ? n : 0;
  }
  typeLabelAcc(t){ const f = this.accountTypes.find(x => x[0]===t); return f ? f[1] : t; }

  accountBalance(acc){
    let b = this.parseNum(acc.initialBalance);
    for (const t of this.state.transactions){
      const amt = this.parseNum(t.amount);
      if (t.type==='Income' && t.accountId===acc.id) b += amt;
      else if (t.type==='Expense' && t.accountId===acc.id) b -= amt;
      else if (t.type==='Transfer'){ if (t.accountId===acc.id) b -= amt; if (t.toAccountId===acc.id) b += amt; }
    }
    return b;
  }
  accountsForNewTransactions(){
    return this.state.accounts.filter(a => a.showInNewTransactions !== false);
  }
  isBudgetDomInput(el){
    return !!(
      el &&
      this.state.view==='budget' &&
      !this.state.modal.open &&
      el.tagName==='INPUT' &&
      el.getAttribute('inputmode')==='decimal'
    );
  }
  budgetDomInputs(){
    if(typeof document==='undefined') return [];
    return Array.from(document.querySelectorAll('input[inputmode="decimal"]')).filter(el => el.offsetParent !== null);
  }
  moveBudgetDomFocus(current, delta){
    const inputs = this.budgetDomInputs();
    const idx = inputs.indexOf(current);
    const next = inputs[idx + delta];
    if(!next) return;
    next.focus();
    if(next.select) requestAnimationFrame(() => next.select());
  }
  budgetCategoryOrder(){
    const expenseCats = this.state.categories.filter(c=>c.type==='Expense');
    const ids = [];
    this.expenseGroupOrder().forEach(g => {
      expenseCats.filter(c=>(c.group||'')===g).forEach(c => ids.push(c.id));
    });
    return ids;
  }
  focusBudgetCategory(categoryId, selectText){
    const el = this.budgetInputRefs[categoryId];
    if(!el) return;
    el.focus();
    if(selectText !== false && typeof el.select === 'function'){
      requestAnimationFrame(() => el.select());
    }
  }
  moveBudgetFocus(categoryId, delta){
    const ids = this.budgetCategoryOrder();
    const idx = ids.indexOf(categoryId);
    if(idx < 0) return;
    const nextId = ids[idx + delta];
    if(nextId) this.focusBudgetCategory(nextId, true);
  }
  onBudgetCellKeyDown(categoryId, e){
    if(e.key==='Enter' || e.key==='Tab'){
      e.preventDefault();
      this.moveBudgetFocus(categoryId, e.shiftKey ? -1 : 1);
    } else if(e.key==='ArrowDown'){
      e.preventDefault();
      this.moveBudgetFocus(categoryId, 1);
    } else if(e.key==='ArrowUp'){
      e.preventDefault();
      this.moveBudgetFocus(categoryId, -1);
    }
  }
  moveAccount(accountId, delta){
    const accounts = this.state.accounts.slice();
    const idx = accounts.findIndex(a => a.id===accountId);
    const nextIdx = idx + delta;
    if(idx < 0 || nextIdx < 0 || nextIdx >= accounts.length) return;
    const next = accounts.slice();
    const tmp = next[idx];
    next[idx] = next[nextIdx];
    next[nextIdx] = tmp;
    this.store.reorder('Accounts', next.map(a => a.id));
    this.refresh();
  }

  /* ---------- navigation ---------- */
  go(view){ this.setState({ view, drawerOpen:false }); }
  toggleGroupCollapse(name){ const collapsedGroups = Object.assign({}, this.state.collapsedGroups, { [name]: !this.state.collapsedGroups[name] }); this.setState({ collapsedGroups }); }
  toggleTheme(){ this.setState({ theme: this.state.theme==='dark' ? 'light' : 'dark' }); }
  togglePrivacy(){
    const next = !this.state.privacyMode;
    if (typeof window !== 'undefined') localStorage.setItem('fp_privacy', next ? '1' : '0');
    this.setState({ privacyMode: next });
  }
  // Oscura un importo già formattato quando la modalità privacy è attiva. Uso un
  // segnaposto a lunghezza fissa (non correlato alla cifra reale) così non si
  // possono indovinare le dimensioni del numero dai puntini mostrati.
  mask(text){ return this.state.privacyMode ? '•••••' : text; }
  // Palette centralizzata: tutti gli sfondi/bordi/testi neutri passano da qui, così il
  // tema chiaro è una vera tavolozza disegnata, non un filtro CSS applicato a forza.
  // I colori "di significato" (blu accento, verde, rosso, ambra, viola, palette grafici)
  // restano identici nei due temi: sono informativi, non di sfondo.
  getPalette(theme){
    if(theme==='light'){
      return {
        bg0:'#f4f2eb', bg1:'#ece8dd', bg2:'#ffffff', bg3:'#e4e0d2',
        b0:'#ece7da', b1:'#e6e1d2', b2:'#dad4c2', b3:'#cdc6b2', b4:'#b3ac97',
        barEmpty:'#ddd6c4', delBorder:'#f0d2ce',
        t0:'#221f18', t1:'#6b675a', t2:'#84806f', t3:'#96917e', t4:'#726e5f', t5:'#96917e', t6:'#3f3b31',
        chipBlue:'#3a63b8', chipRed:'#c23d49'
      };
    }
    return {
      bg0:'#0c0d10', bg1:'#131519', bg2:'#101216', bg3:'#1a1d24',
      b0:'#16181d', b1:'#1c1f26', b2:'#21242b', b3:'#262a32', b4:'#2d313a',
      barEmpty:'#3a3f49', delBorder:'#3a2426',
      t0:'#e7e9ee', t1:'#9297a1', t2:'#6b7079', t3:'#5a5f68', t4:'#8a8f98', t5:'#7d828c', t6:'#c8ccd2',
      chipBlue:'#8fb4f5', chipRed:'#f6a3a9'
    };
  }

  // ---- Autenticazione (solo lato client: scoraggia l'accesso occasionale, non è una vera protezione) ----
  onAuthUsername(e){ this.setState({ auth: Object.assign({}, this.state.auth, { username:e.target.value, error:'' }) }); }
  onAuthPassword(e){ this.setState({ auth: Object.assign({}, this.state.auth, { password:e.target.value, error:'' }) }); }
  onAuthRemember(e){ this.setState({ auth: Object.assign({}, this.state.auth, { remember:e.target.checked }) }); }
  async submitLogin(e){
    if(e && e.preventDefault) e.preventDefault();
    const { username, password, remember } = this.state.auth;
    const email = String(username || '').trim();
    if(!email || !password){
      this.setState({ auth: Object.assign({}, this.state.auth, { error:'Inserisci email e password.' }) });
      return;
    }
    this.setState({ auth: Object.assign({}, this.state.auth, { busy:true, error:'' }) });

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if(error){
      this.setState({ auth: Object.assign({}, this.state.auth, { busy:false, error:'Login non riuscito: ' + error.message }) });
      return;
    }

    if(typeof window!=='undefined'){
      if(remember) localStorage.setItem('fp_remember_user', email);
      else localStorage.removeItem('fp_remember_user');
    }

    try {
      const db = await this.loadOrInitStore();
      this.setState({
        auth: Object.assign({}, this.state.auth, { loggedIn:true, password:'', busy:false, error:'' }),
        accounts: db.Accounts || [], transactions: db.Transactions || [], categories: db.Categories || [],
        groups: db.Groups || [], budgets: db.Budgets || [],
      });
    } catch (err) {
      console.error('Caricamento cloud non riuscito:', err);
      this.setState({ auth: Object.assign({}, this.state.auth, { busy:false, error:'Accesso riuscito, ma caricamento dati cloud non riuscito.' }) });
    }
  }
  async logout(){
    try {
      await supabase.auth.signOut();
    } catch (err) {
      console.error('Logout Supabase non riuscito:', err);
    }
    this.store = null;
    this._supabaseUser = null;
    this.setState({
      auth: Object.assign({}, this.state.auth, { loggedIn:false, password:'', error:'' }),
      accounts: [], transactions: [], categories: [], groups: [], budgets: [],
    });
  }
  showForgotPassword(){ this.setState({ auth: Object.assign({}, this.state.auth, { mode:'forgot', error:'', info:'' }) }); }
  showLoginForm(){ this.setState({ auth: Object.assign({}, this.state.auth, { mode:'login', error:'', info:'', newPassword:'', newPassword2:'' }) }); }
  onNewPassword(e){ this.setState({ auth: Object.assign({}, this.state.auth, { newPassword:e.target.value, error:'' }) }); }
  onNewPassword2(e){ this.setState({ auth: Object.assign({}, this.state.auth, { newPassword2:e.target.value, error:'' }) }); }
  async submitForgotPassword(e){
    if(e && e.preventDefault) e.preventDefault();
    const email = String(this.state.auth.username || '').trim();
    if(!email){
      this.setState({ auth: Object.assign({}, this.state.auth, { error:'Inserisci la tua email.' }) });
      return;
    }
    this.setState({ auth: Object.assign({}, this.state.auth, { busy:true, error:'', info:'' }) });
    const redirectTo = (typeof window !== 'undefined') ? (window.location.origin + window.location.pathname) : undefined;
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    if(error){
      this.setState({ auth: Object.assign({}, this.state.auth, { busy:false, error:'Invio non riuscito: ' + error.message }) });
      return;
    }
    // Messaggio identico che l'email esista o meno nel sistema: evita di rivelare
    // quali indirizzi hanno un account (buona pratica di sicurezza).
    this.setState({ auth: Object.assign({}, this.state.auth, { busy:false, info:'Se l\'indirizzo è registrato, ti abbiamo inviato un\'email con il link per reimpostare la password.' }) });
  }
  async submitResetPassword(e){
    if(e && e.preventDefault) e.preventDefault();
    const { newPassword, newPassword2 } = this.state.auth;
    if(!newPassword || newPassword.length<6){
      this.setState({ auth: Object.assign({}, this.state.auth, { error:'La password deve avere almeno 6 caratteri.' }) });
      return;
    }
    if(newPassword !== newPassword2){
      this.setState({ auth: Object.assign({}, this.state.auth, { error:'Le due password non coincidono.' }) });
      return;
    }
    this.setState({ auth: Object.assign({}, this.state.auth, { busy:true, error:'' }) });
    const { error } = await supabase.auth.updateUser({ password:newPassword });
    if(error){
      this.setState({ auth: Object.assign({}, this.state.auth, { busy:false, error:'Impostazione password non riuscita: ' + error.message }) });
      return;
    }
    // Il link di recupero ha già aperto una sessione valida: da qui possiamo
    // entrare direttamente nell'app senza chiedere di rifare il login.
    try {
      const db = await this.loadOrInitStore();
      this.setState({
        auth: Object.assign({}, this.state.auth, { loggedIn:true, mode:'login', password:'', newPassword:'', newPassword2:'', busy:false, error:'', info:'' }),
        accounts: db.Accounts || [], transactions: db.Transactions || [], categories: db.Categories || [],
        groups: db.Groups || [], budgets: db.Budgets || [], categoryNotes: db.CategoryNotes || [],
      });
    } catch (err) {
      console.error('Caricamento cloud non riuscito:', err);
      this.setState({ auth: Object.assign({}, this.state.auth, { busy:false, error:'Password aggiornata, ma caricamento dati cloud non riuscito. Prova a ricaricare la pagina.' }) });
    }
  }

  /* ---------- modal ---------- */
  today(){ return localTodayIso(); }
  openModal(kind, mode, data){ this.setState({ modal:{ open:true, kind, mode, data: Object.assign({}, data) } }); }
  closeModal(){ this.setState({ modal:{ open:false, kind:null, mode:'create', data:{} } }); }

  newAccount(){ this.openModal('account','create',{ name:'', bank:'', type:'Current Account', initialBalance:'', onBudget:true, showInNewTransactions:true }); }
  editAccount(a){ this.openModal('account','edit',{ id:a.id, name:a.name, bank:a.bank, type:a.type, initialBalance:a.initialBalance, onBudget:a.onBudget!==false, showInNewTransactions:a.showInNewTransactions!==false }); }
  newTransaction(){
    const firstAcc = this.accountsForNewTransactions()[0];
    if(!firstAcc){
      alert('Non ci sono conti disponibili per i nuovi movimenti. Riattiva "Mostra nei nuovi movimenti" in almeno un conto prima di aggiungere un movimento.');
      return;
    }
    const firstExp = this.state.categories.find(c => c.type==='Expense');
    this.openModal('transaction','create',{ type:'Expense', date:this.today(), description:'', accountId: firstAcc?firstAcc.id:'', toAccountId:'', categoryId: firstExp?firstExp.id:'', amount:'', notes:'', cleared:'uncleared' });
  }
  editTransaction(t){ this.openModal('transaction','edit', Object.assign({ toAccountId:'', cleared: t.cleared || (t.reconciled?'reconciled':'uncleared') }, t)); }
  newCategory(type){ this.openModal('category','create',{ name:'', type: type||'Expense', group:'', target:'' }); }
  editCategory(c){ this.openModal('category','edit',{ id:c.id, name:c.name, type:c.type, group:c.group||'', target: c.target? String(c.target).replace('.',','):'' }); }
  newGroup(){ this.openModal('group','create',{ name:'', fixed:false }); }
  editGroup(name){ const g=this.state.groups.find(x=>x.name===name); this.openModal('group','edit',{ id:g?g.id:'', name:name, origName:name, fixed: g?!!g.fixed:false }); }
  delGroup(name){
    const cats=this.state.categories.filter(c=>(c.group||'')===name);
    if(!this.confirmDel('Eliminare il gruppo "'+name+'"?'+(cats.length?(' Le '+cats.length+' categorie verranno spostate in “Senza gruppo”.'):''))) return;
    const g=this.state.groups.find(x=>x.name===name); if(g) this.store.remove('Groups', g.id);
    cats.forEach(c=>this.store.update('Categories', c.id, { group:'' }));
    this.refresh();
  }

  onField(e){
    const f = e.target.dataset.field;
    const val = e.target.type==='checkbox' ? e.target.checked : e.target.value;
    const data = Object.assign({}, this.state.modal.data); data[f] = val;
    this.setState({ modal: Object.assign({}, this.state.modal, { data }) });
  }
  setTxnType(type){
    const data = Object.assign({}, this.state.modal.data, { type });
    if (type==='Transfer'){ data.categoryId=''; if(!data.toAccountId){ const other=this.accountsForNewTransactions().find(a=>a.id!==data.accountId); data.toAccountId=other?other.id:''; } }
    else if (!data.categoryId){ const c=this.state.categories.find(x=>x.type===(type==='Income'?'Income':'Expense')); data.categoryId=c?c.id:''; }
    this.setState({ modal: Object.assign({}, this.state.modal, { data }) });
  }

  setCleared(v){ const data = Object.assign({}, this.state.modal.data, { cleared:v }); this.setState({ modal: Object.assign({}, this.state.modal, { data }) }); }

  saveModal(){
    const m = this.state.modal; const d = m.data; const s = this.store;
    if (m.kind==='move'){ this.doMoveMoney(); return; }
    if (m.kind==='import'){ this.doImport(d.text); return; }
    if (m.kind==='group'){
      const name=(d.name||'').trim(); if(!name){ this.closeModal(); return; }
      if(m.mode==='edit'){
        if(d.id) this.store.update('Groups', d.id, { name, fixed: !!d.fixed });
        this.state.categories.filter(c=>(c.group||'')===d.origName).forEach(c=>this.store.update('Categories', c.id, { group:name }));
      } else if(!this.state.groups.some(g=>g.name===name)){
        this.store.create('Groups', { name, fixed: !!d.fixed });
      }
      this.closeModal(); this.refresh(); return;
    }
    if (m.kind==='account'){
      if (!String(d.name||'').trim()) return;
      const payload = { name:d.name.trim(), bank:(d.bank||'').trim()||'—', type:d.type, initialBalance:this.parseNum(d.initialBalance), onBudget: d.onBudget!==false, showInNewTransactions: d.showInNewTransactions!==false };
      if (m.mode==='edit') s.update('Accounts', d.id, payload); else s.create('Accounts', payload);
    } else if (m.kind==='transaction'){
      const amt = this.parseNum(d.amount);
      if (!amt || !d.accountId) return;
      if (d.type==='Transfer' && (!d.toAccountId || d.toAccountId===d.accountId)) return;
      const cleared = d.cleared || 'uncleared';
      const payload = { date:d.date, description:(d.description||'').trim()||'(senza descrizione)', accountId:d.accountId, type:d.type, categoryId: d.type==='Transfer'?'':(d.categoryId||''), toAccountId: d.type==='Transfer'?d.toAccountId:'', amount:amt, notes:(d.notes||'').trim(), cleared:cleared, reconciled: cleared==='reconciled' };
      if (m.mode==='edit') s.update('Transactions', d.id, payload); else s.create('Transactions', payload);
    } else if (m.kind==='category'){
      if (!String(d.name||'').trim()) return;
      const grp=(d.group||'').trim();
      if(grp && !this.state.groups.some(g=>g.name===grp)) this.store.create('Groups', { name:grp });
      const parsedTarget = this.parseNum(d.target);
      const existing = m.mode==='edit' ? this.state.categories.find(c=>c.id===d.id) : null;
      const payload = { name:d.name.trim(), type:d.type, group:grp, target:parsedTarget };
      // Se l'importo obiettivo viene impostato/modificato da questo modale semplice e la
      // categoria non ha ancora un tipo di obiettivo (mensile/settimanale/annuale/personalizzato),
      // ne assumiamo uno "mensile" di default — l'utente può affinarlo dalla pagina di dettaglio.
      if(parsedTarget>0 && !(existing && existing.targetType)){
        payload.targetType = 'monthly'; payload.targetDay = 1; payload.targetRepeat = true;
      }
      if (m.mode==='edit') s.update('Categories', d.id, payload); else s.create('Categories', payload);
    }
    this.closeModal(); this.refresh();
  }

  confirmDel(msg){ return this.props.confirmDeletes===false ? true : window.confirm(msg); }
  delAccount(a){ if(this.confirmDel('Eliminare il conto "'+a.name+'"? I movimenti collegati resteranno.')){ this.store.remove('Accounts',a.id); this.refresh(); } }
  delTransaction(t){ if(this.confirmDel('Eliminare questo movimento?')){ this.store.remove('Transactions',t.id); this.refresh(); } }
  delCategory(c){ if(this.confirmDel('Eliminare la categoria "'+c.name+'"?')){ this.store.remove('Categories',c.id); this.refresh(); } }
  deleteFromModal(){ const m=this.state.modal; const d=m.data; const map={account:'Accounts',transaction:'Transactions',category:'Categories'}; if(m.kind==='group'){ this.closeModal(); this.delGroup(d.origName); return; } if(this.confirmDel('Eliminare definitivamente?')){ this.store.remove(map[m.kind], d.id); this.closeModal(); this.refresh(); } }

  // Come il campo "Importo" dei movimenti: mentre scrivi teniamo solo il testo grezzo
  // in stato locale (nessun parsing/riformattazione ad ogni tasto). Si converte e si
  // salva nello store solo alla perdita del focus (onAssignBlur), evitando che il
  // valore venga riscritto in formato "0,00" mentre l'utente sta ancora digitando.
  onAssignInput(categoryId, e){
    const budgetEdits = Object.assign({}, this.state.budgetEdits, { [categoryId]: e.target.value });
    this.setState({ budgetEdits });
  }
  onAssignBlur(categoryId, e){
    const raw = this.state.budgetEdits.hasOwnProperty(categoryId) ? this.state.budgetEdits[categoryId] : e.target.value;
    this.store.upsertBudget(this.state.month, categoryId, this.parseNum(raw));
    const budgetEdits = Object.assign({}, this.state.budgetEdits);
    delete budgetEdits[categoryId];
    this.setState({ budgetEdits });
    this.refresh();
  }
  openMoveMoney(categoryId){
    const avail = Math.max(0, this.catAvail(categoryId, this.state.month));
    this.setState({ moveMoney: { fromCategoryId:categoryId, toCategoryId:'', amount: avail?avail.toFixed(2).replace('.',','):'', pickerOpen:false, search:'' } });
  }
  closeMoveMoney(){ this.setState({ moveMoney:null }); }
  setMoveMoneyField(patch){ this.setState({ moveMoney: Object.assign({}, this.state.moveMoney, patch) }); }
  openMovePicker(){ this.setMoveMoneyField({ pickerOpen:true, search:'' }); }
  closeMovePicker(){ this.setMoveMoneyField({ pickerOpen:false }); }
  selectMoveTarget(categoryId){ this.setMoveMoneyField({ toCategoryId:categoryId, pickerOpen:false, search:'' }); }
  commitMoveMoney(){
    const mv = this.state.moveMoney; if(!mv || !mv.fromCategoryId || !mv.toCategoryId) return;
    const amt = this.parseNum(mv.amount);
    if(!amt || amt<=0){ this.closeMoveMoney(); return; }
    const avail = this.catAvail(mv.fromCategoryId, this.state.month);
    const moveAmt = Math.min(amt, Math.max(0, avail));
    if(moveAmt<=0){ this.closeMoveMoney(); return; }
    const fromAssigned = this.catAssignedMonth(mv.fromCategoryId, this.state.month);
    this.store.upsertBudget(this.state.month, mv.fromCategoryId, fromAssigned - moveAmt);
    if(mv.toCategoryId !== '__ready__'){
      const toAssigned = this.catAssignedMonth(mv.toCategoryId, this.state.month);
      this.store.upsertBudget(this.state.month, mv.toCategoryId, toAssigned + moveAmt);
    }
    // Se la destinazione è "Pronto per assegnare" non serve altro: ridurre l'assegnato
    // della categoria di origine fa risalire da solo il pronto per assegnare (stessa
    // identità con cui lo calcoliamo: cassa − disponibile di tutte le categorie).
    this.closeMoveMoney();
    this.refresh();
  }

  // ---- Tastierino "bottom sheet" per assegnare il budget (stile YNAB) ----
  // I "cent" digitati si accumulano in una stringa di sole cifre (come una cassa:
  // l'ultimo tasto premuto è sempre il centesimo più a destra), evitando di dover
  // gestire virgole/separatori mentre l'utente scrive. +/− permettono di sommare o
  // sottrarre un importo a quello di partenza senza dover ricalcolare a mente.
  kpValue(entryDigits){ return (Number.parseInt(entryDigits||'0',10) || 0) / 100; }
  kpDisplay(entryDigits){
    const digits = (entryDigits||'').replace(/^0+(?=\d)/,'');
    const padded = digits.padStart(3,'0');
    const cents = padded.slice(-2);
    const intPart = (padded.slice(0,-2).replace(/^0+(?=\d)/,'') || '0').replace(/\B(?=(\d{3})+(?!\d))/g,'.');
    return intPart + ',' + cents;
  }
  kpLiveTotal(kp){
    const cur = this.kpValue(kp.entryDigits);
    return kp.pendingOp ? (kp.pendingOp==='+' ? kp.baseValue+cur : kp.baseValue-cur) : cur;
  }
  openBudgetKeypad(categoryId){
    const cur = this.catAssignedMonth(categoryId, this.state.month);
    this.setState({ budgetKeypad: { categoryId, entryDigits:String(Math.max(0,Math.round(cur*100))), baseValue:null, pendingOp:null }, statsPopoverOpen:false });
  }
  closeBudgetKeypad(){ this.setState({ budgetKeypad:null, statsPopoverOpen:false }); }
  kpDigit(d){
    const k=this.state.budgetKeypad; if(!k) return;
    let digits = (k.entryDigits==='0') ? '' : (k.entryDigits||'');
    if(digits.length>=9) return;
    this.setState({ budgetKeypad: Object.assign({}, k, { entryDigits: digits+d }) });
  }
  kpBackspace(){ const k=this.state.budgetKeypad; if(!k) return; this.setState({ budgetKeypad: Object.assign({}, k, { entryDigits:(k.entryDigits||'').slice(0,-1) }) }); }
  kpClear(){ const k=this.state.budgetKeypad; if(!k) return; this.setState({ budgetKeypad: Object.assign({}, k, { entryDigits:'', baseValue:null, pendingOp:null }) }); }
  kpOp(op){
    const k=this.state.budgetKeypad; if(!k) return;
    const total = this.kpLiveTotal(k);
    this.setState({ budgetKeypad: Object.assign({}, k, { baseValue: total, pendingOp: op, entryDigits:'' }) });
  }
  kpEquals(){
    const k=this.state.budgetKeypad; if(!k) return;
    const total = Math.max(0, this.kpLiveTotal(k));
    this.setState({ budgetKeypad: Object.assign({}, k, { entryDigits:String(Math.round(total*100)), baseValue:null, pendingOp:null }) });
  }
  kpAutoAssign(){
    const k=this.state.budgetKeypad; if(!k) return;
    const cat = this.state.categories.find(c=>c.id===k.categoryId);
    const target = cat ? this.parseNum(cat.target) : 0;
    if(target<=0) return;
    this.setState({ budgetKeypad: Object.assign({}, k, { entryDigits:String(Math.round(target*100)), baseValue:null, pendingOp:null }) });
  }
  kpMoveMoney(){
    const k=this.state.budgetKeypad; if(!k) return;
    const catId=k.categoryId;
    this.setState({ budgetKeypad:null, statsPopoverOpen:false });
    this.openMoveMoney(catId);
  }
  onKpToggleStats(){ this.setState({ statsPopoverOpen: !this.state.statsPopoverOpen }); }
  kpDone(){
    const k=this.state.budgetKeypad; if(!k) return;
    const total = Math.max(0, this.kpLiveTotal(k));
    this.store.upsertBudget(this.state.month, k.categoryId, total);
    this.setState({ budgetKeypad:null, statsPopoverOpen:false });
    this.refresh();
  }
  doMoveMoney(){
    const d = this.state.modal.data || {};
    const from = d.fromCategoryId, to = d.toCategoryId;
    const amt = this.parseNum(d.amount);
    if(!from || !to || from===to || !amt || amt<=0){ this.closeModal(); return; }
    const avail = this.catAvail(from, this.state.month);
    const moveAmt = Math.min(amt, Math.max(0, avail));
    if(moveAmt<=0){ this.closeModal(); return; }
    const fromAssigned = this.catAssignedMonth(from, this.state.month);
    const toAssigned = this.catAssignedMonth(to, this.state.month);
    this.store.upsertBudget(this.state.month, from, fromAssigned - moveAmt);
    this.store.upsertBudget(this.state.month, to, toAssigned + moveAmt);
    this.closeModal(); this.refresh();
  }

  // ---- Pagina di dettaglio categoria + obiettivi (goal) in stile YNAB ----
  monthsBetween(m1, m2){ // numero di passi da m1 a m2 (m2 >= m1), 0 se stesso mese
    let mo=m1, n=0, guard=0;
    while(mo<m2 && guard<600){ mo=this.addMonth(mo,1); n++; guard++; }
    return n;
  }
  openCategoryDetail(categoryId){ this.setState({ detailCategoryId: categoryId, statsPopoverOpen:false }); }
  closeCategoryDetail(){ this.setState({ detailCategoryId:null, statsPopoverOpen:false }); }
  toggleStatsPopover(){ this.setState({ statsPopoverOpen: !this.state.statsPopoverOpen }); }
  // Importo "da assegnare questo mese" secondo il tipo di obiettivo. Weekly e monthly
  // sono esatti; yearly e custom sono una ripartizione semplificata (non la curva
  // esatta di YNAB) — lo segnalo all'utente perché lo sappia.
  catTargetNeeded(cat, month){
    if(!cat || !cat.targetType || !(this.parseNum(cat.target)>0)) return 0;
    const amt = this.parseNum(cat.target);
    if(cat.targetType==='weekly'){
      const [y,m] = month.split('-').map(Number);
      const daysInMonth = new Date(y, m, 0).getDate();
      let count=0;
      for(let d=1; d<=daysInMonth; d++){ if(new Date(y, m-1, d).getDay()===Number(cat.targetDay||0)) count++; }
      return amt*count;
    }
    if(cat.targetType==='yearly') return amt/12;
    if(cat.targetType==='custom'){
      const due = cat.targetDay||''; if(!due) return amt;
      const dueMonth = due.slice(0,7);
      if(month > dueMonth) return 0;
      let assignedSoFar = 0; let mo = this.earliestMonth(); let guard=0;
      while(mo < month && guard<600){ assignedSoFar += this.catAssignedMonth(cat.id, mo); mo=this.addMonth(mo,1); guard++; }
      const remaining = Math.max(0, amt - assignedSoFar);
      const monthsLeft = Math.max(1, this.monthsBetween(month, dueMonth) + 1);
      return remaining / monthsLeft;
    }
    return amt; // monthly
  }
  catTargetDueLabel(cat){
    if(!cat || !cat.targetType) return '';
    if(cat.targetType==='monthly') return 'entro il ' + (cat.targetDay||1) + ' del mese';
    if(cat.targetType==='weekly'){ const names=['domenica','lunedì','martedì','mercoledì','giovedì','venerdì','sabato']; return 'ogni ' + (names[Number(cat.targetDay||0)]||''); }
    if(cat.targetType==='yearly'){ const md=(cat.targetDay||'01-01').split('-'); return 'entro il ' + md[1] + '/' + md[0] + ' di ogni anno'; }
    if(cat.targetType==='custom') return cat.targetDay ? ('entro il ' + this.fmtDate(cat.targetDay)) : '';
    return '';
  }
  catHistoryStats(catId, month){
    const prevMonth = this.addMonth(month, -1);
    const assignedLastMonth = this.catAssignedMonth(catId, prevMonth);
    const spentLastMonth = this.catSpentMonth(catId, prevMonth);
    let mo = this.earliestMonth(); let sumA=0, sumS=0, n=0; let guard=0;
    while(mo < month && guard<600){ sumA+=this.catAssignedMonth(catId,mo); sumS+=this.catSpentMonth(catId,mo); n++; mo=this.addMonth(mo,1); guard++; }
    return {
      assignedLastMonthText: this.fmtEur(assignedLastMonth),
      spentLastMonthText: this.fmtEur(spentLastMonth),
      avgAssignedText: this.fmtEur(n>0 ? sumA/n : 0),
      avgSpentText: this.fmtEur(n>0 ? sumS/n : 0),
    };
  }
  onCategoryNote(categoryId, e){
    const noteEdits = Object.assign({}, this.state.noteEdits, { [categoryId]: e.target.value });
    this.setState({ noteEdits });
  }
  onCategoryNoteBlur(categoryId, e){
    const raw = this.state.noteEdits.hasOwnProperty(categoryId) ? this.state.noteEdits[categoryId] : e.target.value;
    const month = this.state.month;
    const ex = this.state.categoryNotes.find(n=>n.categoryId===categoryId && n.month===month);
    if(ex) this.store.update('CategoryNotes', ex.id, { text: raw });
    else this.store.create('CategoryNotes', { categoryId, month, text: raw });
    const noteEdits = Object.assign({}, this.state.noteEdits); delete noteEdits[categoryId];
    this.setState({ noteEdits });
    this.refresh();
  }
  toggleHideCategory(categoryId, hidden){ this.store.update('Categories', categoryId, { hidden }); this.refresh(); }
  toggleSnoozeThisMonth(categoryId){
    const cat = this.state.categories.find(c=>c.id===categoryId); if(!cat) return;
    const month = this.state.month;
    const snoozed = (cat.snoozedMonths||[]).slice();
    const idx = snoozed.indexOf(month);
    if(idx>-1) snoozed.splice(idx,1); else snoozed.push(month);
    this.store.update('Categories', categoryId, { snoozedMonths: snoozed });
    this.refresh();
  }
  openTargetEditor(categoryId){
    const cat = this.state.categories.find(c=>c.id===categoryId); if(!cat) return;
    this.setState({ targetEditor: {
      categoryId,
      type: cat.targetType || 'monthly',
      amount: cat.target ? String(cat.target).replace('.',',') : '',
      day: cat.targetDay!=null ? cat.targetDay : 1,
      date: cat.targetType==='custom' ? (cat.targetDay||'') : '',
      repeat: cat.targetRepeat!==false,
    }});
  }
  closeTargetEditor(){ this.setState({ targetEditor:null }); }
  setTargetEditorField(patch){ this.setState({ targetEditor: Object.assign({}, this.state.targetEditor, patch) }); }
  saveTargetEditor(){
    const te = this.state.targetEditor; if(!te) return;
    const patch = {
      target: this.parseNum(te.amount),
      targetType: te.type,
      targetDay: te.type==='custom' ? te.date : te.day,
      targetRepeat: !!te.repeat,
    };
    this.store.update('Categories', te.categoryId, patch);
    this.setState({ targetEditor:null });
    this.refresh();
  }
  deleteTargetEditor(){
    const te = this.state.targetEditor; if(!te) return;
    this.store.update('Categories', te.categoryId, { target:0, targetType:'', targetDay:null, targetRepeat:false });
    this.setState({ targetEditor:null });
    this.refresh();
  }
  goToCategoryActivity(categoryId){
    const month = this.state.month;
    const from = month+'-01'; const to = month+'-31';
    this.setState({ view:'transactions', filters: Object.assign({}, this.state.filters, { categoryId, from, to, accountId:'', type:'', search:'' }), detailCategoryId:null });
  }

  /* ---------- filtered transactions (shared by list + export) ---------- */
  filteredTxns(){
    const f = this.state.filters; let txns = this.state.transactions.slice();
    if (f.from) txns = txns.filter(t => t.date >= f.from);
    if (f.to) txns = txns.filter(t => t.date <= f.to);
    if (f.accountId) txns = txns.filter(t => t.accountId===f.accountId || t.toAccountId===f.accountId);
    if (f.categoryId) txns = txns.filter(t => t.categoryId===f.categoryId);
    if (f.type) txns = txns.filter(t => t.type===f.type);
    const q = String(f.search||'').trim().toLowerCase();
    if(q){
      const accMap = {}; this.state.accounts.forEach(a=>{ accMap[a.id]=a.name||''; });
      const catMap = {}; this.state.categories.forEach(c=>{ catMap[c.id]=c.name||''; });
      txns = txns.filter(t => {
        const amountRaw = String(t.amount||'');
        const amount = amountRaw.replace('.',',');
        const text = [
          t.description, t.notes, amountRaw, amount, this.fmtEur(t.amount),
          catMap[t.categoryId], accMap[t.accountId], accMap[t.toAccountId]
        ].join(' ').toLowerCase();
        return text.indexOf(q) > -1;
      });
    }
    txns.sort((a,b) => (a.date<b.date?1:a.date>b.date?-1:0));
    return txns;
  }

  /* ---------- dashboard / report helpers ---------- */
  accById(id){ return this.state.accounts.find(a=>a.id===id) || {}; }
  monthAbbr(mo){ const p=mo.split('-'); return this.monthAbbrArr[parseInt(p[1],10)-1] + ' ' + p[0].slice(2); }
  lastDayOf(mo){ const p=mo.split('-'); return mo + '-' + String(new Date(parseInt(p[0],10), parseInt(p[1],10), 0).getDate()).padStart(2,'0'); }
  monthsInRange(n){ const cur = this.today().slice(0,7); const arr=[]; for(let i=n-1;i>=0;i--) arr.push(this.addMonth(cur,-i)); return arr; }
  monthAgg(mo, accId, catSet){
    let income=0, expense=0;
    for(const t of this.state.transactions){
      if((t.date||'').slice(0,7) !== mo) continue;
      if(accId && t.accountId !== accId) continue;
      if(t.type==='Income') income += this.parseNum(t.amount);
      else if(t.type==='Expense'){ if(catSet && catSet.indexOf(t.categoryId)<0) continue; expense += this.parseNum(t.amount); }
    }
    return { income, expense };
  }
  expenseGroupOrder(){
    const order = this.state.groups.map(g=>g.name);
    const cats = this.state.categories.filter(c=>c.type==='Expense');
    const names = order.slice();
    cats.forEach(c=>{ const g=c.group||''; if(g && names.indexOf(g)<0) names.push(g); });
    if(cats.some(c=>!(c.group||''))) names.push('');
    return names;
  }
  nwAt(mo, accId){
    const inSet = (id) => accId ? id===accId : true;
    let bal = accId ? this.parseNum(this.accById(accId).initialBalance) : this.state.accounts.reduce((s,a)=>s+this.parseNum(a.initialBalance),0);
    for(const t of this.state.transactions){
      if((t.date||'').slice(0,7) > mo) continue;
      const amt = this.parseNum(t.amount);
      if(t.type==='Income' && inSet(t.accountId)) bal += amt;
      else if(t.type==='Expense' && inSet(t.accountId)) bal -= amt;
      else if(t.type==='Transfer'){ if(inSet(t.accountId)) bal -= amt; if(inSet(t.toAccountId)) bal += amt; }
    }
    return bal;
  }
  catSpentMonth(catId, mo){
    let s=0;
    for(const t of this.state.transactions){ if(t.type==='Expense' && t.categoryId===catId && (t.date||'').slice(0,7)===mo) s += this.parseNum(t.amount); }
    return s;
  }
  catAssignedMonth(catId, mo){ const b = this.state.budgets.find(x=>x.month===mo && x.categoryId===catId); return b ? this.parseNum(b.assigned) : 0; }
  earliestMonth(){
    let min=null;
    for(const t of this.state.transactions){ const m=(t.date||'').slice(0,7); if(m && (!min || m<min)) min=m; }
    for(const b of this.state.budgets){ if(b.month && (!min || b.month<min)) min=b.month; }
    return min || this.state.month;
  }
  catAvail(catId, mo){ return this.catCarryover(catId, mo) + this.catAssignedMonth(catId, mo) - this.catSpentMonth(catId, mo); }
  // Riporto per categoria verso `month`: se un mese chiude con Disponibile negativo
  // (sforamento), quel negativo NON si trascina dentro la categoria il mese dopo —
  // si azzera. Il riporto positivo invece si accumula normalmente (risparmi/obiettivi).
  catCarryover(catId, month){
    let mo=this.earliestMonth(); let carry=0; let guard=0;
    while(mo < month && guard<600){
      const avail = carry + this.catAssignedMonth(catId,mo) - this.catSpentMonth(catId,mo);
      carry = Math.max(avail, 0);
      mo=this.addMonth(mo,1); guard++;
    }
    return carry;
  }
  onBudgetCash(){ return this.state.accounts.filter(a=>a.onBudget!==false).reduce((s,a)=>s+this.accountBalance(a),0); }
  ageOfMoney(dMonths, dAcc){
    const inP=(d)=>dMonths.indexOf((d||'').slice(0,7))>-1;
    let exp=0; const active={};
    for(const t of this.state.transactions){ if(t.type==='Expense' && inP(t.date) && (!dAcc||t.accountId===dAcc)){ exp+=this.parseNum(t.amount); active[(t.date||'').slice(0,7)]=1; } }
    const nMonths = Math.max(1, Object.keys(active).length);
    const perDay = exp>0 ? exp/(nMonths*30) : 0;
    if(perDay<=0) return null;
    const liquid = { 'Current Account':1,'Card':1,'Cash':1 };
    const cash = dAcc ? this.accountBalance(this.accById(dAcc)) : this.state.accounts.filter(a=>a.onBudget!==false && liquid[a.type]).reduce((s,a)=>s+this.accountBalance(a),0);
    return Math.max(0, Math.round(cash/perDay));
  }
  /* ---------- Dashboard / Report unificati (un solo filtro periodo+conto, 4 schede stile YNAB) ---------- */
  setDashTab(tab){ this.setState({ dash: Object.assign({}, this.state.dash, { tab }) }); }
  goDashTab(tab){ this.setState({ view:'dashboard', drawerOpen:false, dash: Object.assign({}, this.state.dash, { tab }) }); }
  setDashRange(range){ this.setState({ dash: Object.assign({}, this.state.dash, { range }) }); }
  setDashCustomDate(field, value){ this.setState({ dash: Object.assign({}, this.state.dash, { range:'custom', [field]:value }) }); }
  setDashAccount(e){ this.setState({ dash: Object.assign({}, this.state.dash, { accountId:e.target.value }) }); }
  setDashGroup(e){ const groupId=e.target.value; const dash=Object.assign({}, this.state.dash, { groupId }); if(dash.categoryId){ const c=this.state.categories.find(x=>x.id===dash.categoryId); if(groupId && (!c || (c.group||'')!==groupId)) dash.categoryId=''; } this.setState({ dash }); }
  setDashCategory(e){ const categoryId=e.target.value; const dash=Object.assign({}, this.state.dash, { categoryId }); if(categoryId){ const c=this.state.categories.find(x=>x.id===categoryId); if(c) dash.groupId=c.group||''; } this.setState({ dash }); }
  clearDashFilter(){ this.setState({ dash: Object.assign({}, this.state.dash, { groupId:'', categoryId:'' }) }); }
  dashMonthsFor(range){
    const cur = this.today().slice(0,7);
    if(range==='custom'){
      const raw1 = (this.state.dash.customFrom||'').slice(0,7);
      const raw2 = (this.state.dash.customTo||'').slice(0,7);
      if(!raw1 || !raw2) return this.monthsInRange(6);
      let start = raw1, end = raw2;
      if(start > end){ const t=start; start=end; end=t; }
      const arr=[]; let mo=start; let guard=0;
      while(mo<=end && guard<600){ arr.push(mo); mo=this.addMonth(mo,1); guard++; }
      return arr.length ? arr : [cur];
    }
    if(range==='ytd'){
      const y = cur.slice(0,4); const arr=[]; let mo=y+'-01'; let guard=0;
      while(mo<=cur && guard<12){ arr.push(mo); mo=this.addMonth(mo,1); guard++; }
      return arr;
    }
    if(range==='all'){
      const start=this.earliestMonth(); const arr=[]; let mo=start; let guard=0;
      while(mo<=cur && guard<600){ arr.push(mo); mo=this.addMonth(mo,1); guard++; }
      return arr.length ? arr : [cur];
    }
    const n = ({ '1m':1, '3m':3, '6m':6, '12m':12 })[range] || 6;
    return this.monthsInRange(n);
  }
  drillMonth(mo){ this.setState({ view:'transactions', drawerOpen:false, filters:{ from:mo+'-01', to:this.lastDayOf(mo), accountId:this.state.dash.accountId, categoryId:'', type:'', search:'' } }); }
  drillCategory(cid, fromMo, toMo, type){ this.setState({ view:'transactions', drawerOpen:false, filters:{ from:fromMo+'-01', to:this.lastDayOf(toMo), accountId:this.state.dash.accountId, categoryId:cid, type: type||'Expense', search:'' } }); }

  /* ---------- CSV export / import ---------- */
  fmtDate2(iso){ if(!iso) return ''; const p = iso.split('-'); return p[2]+'/'+p[1]+'/'+p[0]; }
  csvNum(v){ return Math.abs(this.parseNum(v)); }
  parseDate(v){ v=(v||'').trim(); if(!v) return ''; if(/^\d{4}-\d{2}-\d{2}$/.test(v)) return v; const m=v.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/); if(m){ let d=m[1], mo=m[2], y=m[3]; if(y.length===2) y='20'+y; return y+'-'+String(mo).padStart(2,'0')+'-'+String(d).padStart(2,'0'); } return ''; }
  parseCsv(text){
    const rows = []; const lines = String(text).replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
    for (const line of lines){
      if (line.trim()==='') continue;
      const cells = []; let cur=''; let q=false;
      for (let i=0;i<line.length;i++){ const ch=line[i];
        if (q){ if(ch==='"'){ if(line[i+1]==='"'){ cur+='"'; i++; } else q=false; } else cur+=ch; }
        else { if(ch==='"') q=true; else if(ch===';'){ cells.push(cur); cur=''; } else cur+=ch; }
      }
      cells.push(cur); rows.push(cells.map(c=>c.trim()));
    }
    return rows;
  }
  download(name, text, mime){
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download=name; document.body.appendChild(a); a.click();
    setTimeout(()=>{ document.body.removeChild(a); URL.revokeObjectURL(url); }, 120);
  }
  exportCsv(){
    const txns = this.filteredTxns();
    const accMap={}; this.state.accounts.forEach(a=>accMap[a.id]=a);
    const catMap={}; this.state.categories.forEach(c=>catMap[c.id]=c);
    const typeLbl={ Income:'Entrata', Expense:'Uscita', Transfer:'Trasferimento' };
    const esc=(v)=>{ v = (v==null?'':String(v)); return /[";\n]/.test(v) ? '"'+v.replace(/"/g,'""')+'"' : v; };
    const stLbl={ reconciled:'Riconciliato', cleared:'Liquidato', uncleared:'Non liquidato' };
    const head=['Data','Descrizione','Conto','Conto destinazione','Tipo','Categoria','Importo','Note','Stato'];
    const lines=[head.join(';')];
    for (const t of txns){
      lines.push([ this.fmtDate2(t.date), t.description, (accMap[t.accountId]?accMap[t.accountId].name:''), (t.toAccountId&&accMap[t.toAccountId]?accMap[t.toAccountId].name:''), typeLbl[t.type], (t.categoryId&&catMap[t.categoryId]?catMap[t.categoryId].name:''), String(t.amount).replace('.',','), (t.notes||''), (stLbl[t.cleared]||(t.reconciled?'Riconciliato':'Non liquidato')) ].map(esc).join(';'));
    }
    const stamp = this.today();
    this.download('movimenti-'+stamp+'.csv', '﻿'+lines.join('\r\n'), 'text/csv;charset=utf-8');
  }
  downloadTemplate(){
    const head='Data;Descrizione;Conto;Conto destinazione;Tipo;Categoria;Importo;Note;Stato';
    const ex=[ '01/07/2026;Stipendio luglio;Conto Corrente;;Entrata;Stipendio;2600,00;;Riconciliato', '02/07/2026;Spesa Esselunga;Revolut;;Uscita;Spesa alimentare;76,40;Settimanale;Non liquidato', '05/07/2026;Giroconto risparmio;Conto Corrente;Deposito Findomestic;Trasferimento;;500,00;;Liquidato' ];
    this.download('modello-movimenti.csv', '﻿'+[head].concat(ex).join('\r\n'), 'text/csv;charset=utf-8');
  }
  openImport(){ this.openModal('import','create',{ text:'', fileName:'' }); }
  onImportFile(e){
    const file = e.target.files && e.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = () => { const data = Object.assign({}, this.state.modal.data, { text: String(reader.result||''), fileName: file.name }); this.setState({ modal: Object.assign({}, this.state.modal, { data }) }); };
    reader.readAsText(file);
  }
  doImport(text){
    text = String(text||'').trim();
    if(!text){ alert('Nessun dato da importare. Scegli un file o incolla il CSV.'); return; }
    const rows = this.parseCsv(text);
    if(!rows.length){ alert('CSV vuoto o non valido.'); return; }
    let start=0;
    const h0=(rows[0]||[]).join(' ').toLowerCase();
    if(/data|descriz|importo|conto|tipo/.test(h0) && !/^\d/.test((rows[0][0]||'').trim())) start=1;
    const accByName={}; this.state.accounts.forEach(a=>accByName[a.name.trim().toLowerCase()]=a.id);
    const catByName={}; this.state.categories.forEach(c=>catByName[c.name.trim().toLowerCase()]=c);
    const typeMap={ entrata:'Income', income:'Income', uscita:'Expense', expense:'Expense', trasferimento:'Transfer', transfer:'Transfer' };
    let added=0, skipped=0;
    for(let i=start;i<rows.length;i++){
      const r=rows[i]; if(!r || r.join('').trim()==='') continue;
      const date=this.parseDate(r[0]);
      const desc=(r[1]||'').trim();
      const accName=(r[2]||'').trim().toLowerCase();
      const toName=(r[3]||'').trim().toLowerCase();
      const type=typeMap[(r[4]||'').trim().toLowerCase()]||'Expense';
      const catName=(r[5]||'').trim();
      const amount=this.csvNum(r[6]);
      const notes=(r[7]||'').trim();
      const stRaw=(r[8]||'').trim().toLowerCase();
      const cleared = /riconc|reconcil/.test(stRaw) ? 'reconciled' : ((/liquid|clear/.test(stRaw) && !/non/.test(stRaw)) ? 'cleared' : (/^(s|sì|si|true|1|x|yes)$/i.test(stRaw)?'reconciled':'uncleared'));
      const rec = cleared==='reconciled';
      const accountId=accByName[accName];
      if(!date || !amount || !accountId){ skipped++; continue; }
      let toAccountId='';
      if(type==='Transfer'){ toAccountId=accByName[toName]||''; if(!toAccountId || toAccountId===accountId){ skipped++; continue; } }
      let categoryId='';
      if(type!=='Transfer' && catName){
        const key=catName.toLowerCase();
        if(catByName[key]) categoryId=catByName[key].id;
        else { const created=this.store.create('Categories',{ name:catName, type:type }); catByName[key]=created; categoryId=created.id; }
      }
      this.store.create('Transactions',{ date, description:desc||'(importato)', accountId, type, toAccountId, categoryId, amount, notes, cleared, reconciled:rec });
      added++;
    }
    this.closeModal(); this.refresh();
    alert('Importati '+added+' movimenti'+(skipped?(', '+skipped+' righe ignorate (conto, importo o data mancanti).'):'.'));
  }

  resetBudgets(){ if(window.confirm('Azzerare tutte le assegnazioni di budget, di tutti i mesi? Conti, movimenti e categorie NON vengono toccati: si azzera solo quanto assegnato a ciascuna categoria, per ripartire con "Pronto per assegnare" pari al patrimonio dei conti nel budget.')){ this.store.clearBudgets(); this.refresh(); } }

  onFilterChange(e){ const k = e.target.dataset.filter; const filters = Object.assign({}, this.state.filters); filters[k] = e.target.value; this.setState({ filters, selectedTxnIds:{} }); }
  clearFilters(){ this.setState({ filters:{ from:'', to:'', accountId:'', categoryId:'', type:'', search:'' }, selectedTxnIds:{} }); }
  toggleTxnSelect(id){ const selectedTxnIds = Object.assign({}, this.state.selectedTxnIds); if(selectedTxnIds[id]) delete selectedTxnIds[id]; else selectedTxnIds[id]=true; this.setState({ selectedTxnIds }); }
  toggleSelectAllTxns(ids){
    const allSelected = ids.length>0 && ids.every(id=>this.state.selectedTxnIds[id]);
    if(allSelected){ this.setState({ selectedTxnIds:{} }); return; }
    const selectedTxnIds = {}; ids.forEach(id=>{ selectedTxnIds[id]=true; });
    this.setState({ selectedTxnIds });
  }
  clearTxnSelection(){ this.setState({ selectedTxnIds:{} }); }
  deleteSelectedTxns(){
    const ids = Object.keys(this.state.selectedTxnIds);
    if(!ids.length) return;
    if(!this.confirmDel('Eliminare '+ids.length+' movimenti selezionati?')) return;
    ids.forEach(id=>this.store.remove('Transactions', id));
    this.setState({ selectedTxnIds:{} });
    this.refresh();
  }

  /* ---------- render ---------- */
  buildViewModel(){
    const st = this.state;
    const isLight = st.theme === 'light';
    const C = this.getPalette(st.theme);
    const P = { text:C.t0, muted:C.t1, dim:C.t2, accent:'#5b8def', green:'#3ecf8e', red:'#f0616d', amber:'#e2b341' };
    const accMap = {}; st.accounts.forEach(a => accMap[a.id]=a);
    const catMap = {}; st.categories.forEach(c => catMap[c.id]=c);

    // sidebar / layout
    const collapsed = st.collapsed && !st.isMobile;
    let sidebarStyle;
    if (st.isMobile){
      sidebarStyle = { position:'fixed', top:0, left:0, bottom:0, width:'236px', flexShrink:0, padding:'20px 16px', display:'flex', flexDirection:'column', background:C.bg1, borderRight:'1px solid '+C.b1, zIndex:50, transform: st.drawerOpen ? 'translateX(0)' : 'translateX(-110%)', transition:'transform .25s cubic-bezier(.2,.8,.3,1)', boxShadow: st.drawerOpen ? '0 0 40px rgba(0,0,0,0.6)' : 'none' };
    } else if (collapsed){
      sidebarStyle = { width:'0px', flexShrink:0, padding:'20px 0', display:'flex', flexDirection:'column', background:C.bg1, borderRight:'1px solid transparent', overflow:'hidden', opacity:0, transition:'width .22s ease, padding .22s ease, opacity .18s ease', pointerEvents:'none' };
    } else {
      sidebarStyle = { width:'236px', flexShrink:0, padding:'20px 16px', display:'flex', flexDirection:'column', background:C.bg1, borderRight:'1px solid '+C.b1, overflow:'hidden', transition:'width .22s ease, padding .22s ease, opacity .18s ease' };
    }
    const navItem = (active) => ({ display:'flex', alignItems:'center', gap:'11px', width:'100%', padding:'9px 11px', border:'none', borderRadius:'9px', fontSize:'13.5px', fontWeight:600, cursor:'pointer', textAlign:'left', background: active?C.bg3:'transparent', color: active?C.t0:C.t5, transition:'background .12s' });
    const navStyle = { dashboard:navItem(st.view==='dashboard'), budget:navItem(st.view==='budget'), transactions:navItem(st.view==='transactions'), accounts:navItem(st.view==='accounts'), categories:navItem(st.view==='categories') };

    // net worth
    const netWorth = st.accounts.reduce((sum,a)=> sum + this.accountBalance(a), 0);
    const netWorthStyle = { fontFamily:"'JetBrains Mono',monospace", fontWeight:600, fontSize:'21px', marginTop:'4px', color: netWorth<0?P.red:P.text };

    // header
    const dashTitleMap = {
      networth:['Patrimonio netto','Andamento nel tempo e composizione degli attivi'],
      incomeexpense:['Entrate vs Uscite','Confronto mensile e tasso di risparmio'],
      spending:['Spese per categoria','Dove vanno a finire le tue uscite'],
      incomebreakdown:['Entrate per fonte','Da dove arrivano le tue entrate'],
      savings:['Risparmio & Età del denaro','Quanto risparmi e per quanti giorni sei coperto']
    };
    const titles = { dashboard: dashTitleMap[st.dash.tab] || dashTitleMap.networth, budget:['Budget','Assegna ogni euro alle tue categorie'], transactions:['Movimenti','Tutte le entrate, uscite e trasferimenti'], accounts:['Conti','Saldi aggiornati automaticamente'], categories:['Categorie','Organizza entrate e uscite'] };
    const navTitle = titles[st.view][0]; const navSubtitle = titles[st.view][1];
    const primaryMap = { dashboard:['Nuovo movimento', ()=>this.newTransaction()], budget:['Nuova categoria', ()=>this.newCategory('Expense')], transactions:['Nuovo movimento', ()=>this.newTransaction()], accounts:['Nuovo conto', ()=>this.newAccount()], categories:['Nuova categoria', ()=>this.newCategory('Expense')] };
    const primaryLabel = primaryMap[st.view][0]; const onPrimary = primaryMap[st.view][1];

    // BUDGET
    const monthTxns = st.transactions.filter(t => (t.date||'').slice(0,7)===st.month);
    const budgetMap = {}; st.budgets.filter(b=>b.month===st.month).forEach(b=> budgetMap[b.categoryId]=this.parseNum(b.assigned));
    const expenseCatList = st.categories.filter(c=>c.type==='Expense' && !c.hidden);
    let totalAssigned = 0;
    let totalAvail = 0;
    const buildBudgetRow = (c) => {
      const assigned = budgetMap[c.id] || 0; totalAssigned += assigned;
      const spent = monthTxns.filter(t=>t.type==='Expense' && t.categoryId===c.id).reduce((s,t)=>s+this.parseNum(t.amount),0);
      const carry = this.catCarryover(c.id, st.month);
      const avail = carry + assigned - spent;
      totalAvail += avail;
      const kp = st.budgetKeypad;
      const kpActive = !!(kp && kp.categoryId===c.id);
      const displayAssigned = kpActive ? Math.max(0,this.kpLiveTotal(kp)) : assigned;
      const displayAvail = carry + displayAssigned - spent;
      const target = this.parseNum(c.target);
      const pct = target>0 ? Math.min(100,(displayAssigned/target)*100) : (displayAssigned>0 ? Math.min(100,(spent/displayAssigned)*100) : (spent>0?100:0));
      const over = displayAvail < -0.005;
      const availColor = over ? P.red : (displayAvail<0.005 ? P.muted : P.green);
      const funded = target>0 && displayAssigned+0.005>=target;
      const barColor = over ? P.red : (target>0 ? (funded?P.green:P.accent) : (displayAssigned===0?C.barEmpty:P.accent));
      const totalForMonth = carry + displayAssigned;
      const fullySpent = Math.abs(displayAvail) < 0.005 && totalForMonth > 0.005;
      let hint='';
      if(fullySpent){ hint = 'Speso tutto'; }
      else if(target>0){
        const need=target-displayAssigned;
        hint = need>0.005 ? ('Obiettivo '+this.fmtEur(target)+' · mancano '+this.fmtEur(need)) : ('Finanziato · speso '+this.fmtEur(spent)+' di '+this.fmtEur(totalForMonth));
      } else if(totalForMonth>0.005){ hint = 'Speso '+this.fmtEur(spent)+' di '+this.fmtEur(totalForMonth); }
      const showFundedCheck = funded && !over;
      const availPillStyle = { display:'inline-flex', alignItems:'center', gap:'4px', padding: Math.abs(displayAvail)>0.005 ? '3px 9px' : '0', borderRadius:'999px', fontFamily:"'JetBrains Mono',monospace", fontWeight:600, fontSize:'12.5px', background: over?'rgba(240,97,109,0.12)':(displayAvail>0.005?'rgba(62,207,142,0.12)':'transparent'), color:availColor };
      return { id:c.id, name:c.name, hint, hasHint:!!hint, hintStyle:{ fontSize:'11.5px', color:(target>0&&!funded)?'#e2b341':C.t3, marginTop:'3px' }, assigned, spent, avail, kpActive,
        rowStyle: kpActive ? { background:'rgba(91,141,239,0.14)' } : null,
        assignedValue: st.budgetEdits.hasOwnProperty(c.id) ? st.budgetEdits[c.id] : (assigned ? assigned.toFixed(2).replace('.',',') : ''),
        assignedDisplayText: kpActive ? this.kpDisplay(kp.entryDigits) : (assigned ? assigned.toFixed(2).replace('.',',') : '0,00'),
        spentText:this.fmtEur(spent), availText:this.fmtEur(displayAvail), availStyle:{ fontFamily:"'JetBrains Mono',monospace", fontWeight:600, fontSize:'13px', color:availColor }, availPillStyle, showFundedCheck, barStyle:{ height:'100%', width:pct+'%', background:barColor, borderRadius:'4px', transition:'width .3s' }, assignedRef:(el)=>{ this.budgetInputRefs[c.id]=el; }, onAssign:(e)=>this.onAssignInput(c.id,e), onAssignBlur:(e)=>this.onAssignBlur(c.id,e), onAssignFocus:(e)=>e.currentTarget.select(), onAssignKeyDown:(e)=>this.onBudgetCellKeyDown(c.id,e), onOpenKeypad:()=>this.openBudgetKeypad(c.id), onOpenDetail:()=>this.openCategoryDetail(c.id), onMove:()=>this.openMoveMoney(c.id) };
    };
    const groupNames = this.expenseGroupOrder();
    const budgetGroups = groupNames.map(g => {
      const rows = expenseCatList.filter(c=>(c.group||'')===g).map(buildBudgetRow);
      const gAssigned = rows.reduce((s,r)=>s+r.assigned,0);
      const gSpent = rows.reduce((s,r)=>s+r.spent,0);
      const gAvail = rows.reduce((s,r)=>s+r.avail,0);
      const gAvailColor = gAvail<-0.005?P.red:(gAvail>0.005?P.green:P.muted);
      const collapsed = !!st.collapsedGroups[g];
      return { name: g||'Senza gruppo', rows, assignedText:this.fmtEur(gAssigned), spentText:this.fmtEur(gSpent), availText:this.fmtEur(gAvail), availStyle:{ fontFamily:"'JetBrains Mono',monospace", fontWeight:600, fontSize:'11.5px', color:gAvailColor }, isEmpty: rows.length===0, collapsed, onToggleCollapse:()=>this.toggleGroupCollapse(g), chevronStyle:{ width:'14px', height:'14px', flexShrink:'0', transition:'transform .15s', transform: collapsed?'rotate(-90deg)':'rotate(0deg)', cursor:'pointer', color:C.t2 } };
    }).filter(gr => !(gr.isEmpty && gr.name==='Senza gruppo'));
    // Pronto per assegnare = liquidità nei conti di budget − tutto ciò che risulta
    // ancora "disponibile" nelle categorie in questo mese, riporto incluso.
    // Il "disponibile" di categoria (carry + assegnato − speso) include già il
    // riporto dei saldi positivi dai mesi precedenti: quei soldi restano "vincolati"
    // alla categoria (es. Fondo casa 18.000€ a luglio, pur con assegnato 0 a luglio)
    // e NON devono ricomparire come liquidità pronta da assegnare. Un eventuale
    // sforamento (disponibile negativo) di un mese passato non si riporta più nella
    // categoria (si chiude, catCarryover lo azzera) ma resta comunque sottratto qui,
    // perché la spesa reale ha già ridotto la liquidità nei conti.
    // Invariante: Pronto per assegnare + Σ disponibile di tutte le categorie = liquidità reale.
    const ready = this.onBudgetCash() - totalAvail;
    const readyPositive = ready >= -0.005;
    const readyWarning = !readyPositive;
    const readyZero = Math.abs(ready) < 0.005;
    const readyCardStyle = { padding:'10px 16px', borderRadius:'12px', textAlign:'right', minWidth:'170px', maxWidth:'270px', border:'1px solid', borderWidth: readyWarning?'2px':'1px', background: readyZero?'rgba(226,179,65,0.12)':(readyPositive?'rgba(62,207,142,0.09)':'rgba(240,97,109,0.13)'), borderColor: readyZero?'rgba(226,179,65,0.35)':(readyPositive?'rgba(62,207,142,0.3)':'rgba(240,97,109,0.6)'), color: readyZero?P.amber:(readyPositive?P.green:P.red), boxShadow: readyWarning?'0 0 0 3px rgba(240,97,109,0.14)':'none' };
    const readyLabel = readyZero ? 'Tutto assegnato' : (readyPositive ? 'Pronto per assegnare' : 'Sovra-assegnato');
    const readyText = this.fmtEur(ready);
    const readySubtext = readyWarning ? ("Hai assegnato "+this.fmtEur(-ready)+" più di quanto possiedi. Riduci gli importi assegnati o sposta fondi da un'altra categoria con \"Sposta\".") : '';

    // ============ DASHBOARD / REPORT (unificati: un solo filtro, KPI coerenti, 4 schede) ============
    const dash = st.dash;
    const dMonths = this.dashMonthsFor(dash.range);
    const dAcc = dash.accountId;
    let dashCatSet=null;
    if(dash.categoryId) dashCatSet=[dash.categoryId];
    else if(dash.groupId) dashCatSet=st.categories.filter(c=>c.type==='Expense' && (c.group||'')===dash.groupId).map(c=>c.id);
    const curMonth = this.today().slice(0,7);
    const spendPalette = ['#5b8def','#3ecf8e','#e2b341','#8b7cf6','#f0616d','#4bb6c9','#e08a4b','#c98bd0','#7d9a4b','#d0576b','#5bbfae',C.t1];
    const dFromMo = dMonths[0], dToMo = dMonths[dMonths.length-1];
    const dInPeriod = (d) => dMonths.indexOf((d||'').slice(0,7)) > -1;

    // -- Filtro periodo/conto (un'unica barra, condivisa da KPI e dalle 4 schede) --
    const dashRangeBtns = [['1m','1M'],['3m','3M'],['6m','6M'],['12m','1A'],['ytd','YTD'],['all','Tutto'],['custom','Personalizzato']].map(x => ({
      key:x[0], label:x[1], onClick:()=>this.setDashRange(x[0]),
      style:{ padding:'6px 12px', border:'none', borderRadius:'7px', fontSize:'12.5px', fontWeight:600, cursor:'pointer', background: dash.range===x[0]?'#5b8def':'transparent', color: dash.range===x[0]?'#fff':C.t1, transition:'all .12s' }
    }));
    const dashAccountOptions = st.accounts.map(a=>({ value:a.id, label:a.name }));
    const dashPeriodLabel = dMonths.length>1 ? (this.monthAbbr(dFromMo) + ' – ' + this.monthAbbr(dToMo)) : this.monthAbbr(dFromMo);
    const dashCustomOpen = dash.range==='custom';
    const dashCustomFrom = dash.customFrom||'';
    const dashCustomTo = dash.customTo||'';
    const onDashCustomFrom = (e)=>this.setDashCustomDate('customFrom', e.target.value);
    const onDashCustomTo = (e)=>this.setDashCustomDate('customTo', e.target.value);

    // -- KPI (sempre visibili, indipendenti dalla scheda attiva) --
    let periodIncome=0, periodExpense=0;
    const ieRaw = dMonths.map(mo => { const a=this.monthAgg(mo,dAcc,null); periodIncome+=a.income; periodExpense+=a.expense; return { mo, income:a.income, expense:a.expense }; });
    const periodNet = periodIncome - periodExpense;
    const savingsRate = periodIncome>0 ? Math.round((periodNet/periodIncome)*100) : 0;
    const netWorthNow = this.nwAt(curMonth, dAcc);
    const aom = this.ageOfMoney(dMonths, dAcc);
    const kpis = [
      { label: dAcc?'Saldo conto':'Patrimonio netto', value:this.mask(this.fmtEur(netWorthNow)), sub:'ad oggi', valColor: netWorthNow<0?P.red:P.text },
      { label:'Entrate', value:this.fmtEur(periodIncome), sub:'nel periodo', valColor:P.green },
      { label:'Uscite', value:this.fmtEur(periodExpense), sub:'nel periodo', valColor:P.red },
      { label:'Risparmio netto', value:this.fmtEur(periodNet), sub: (periodNet>=0?'tasso ':'deficit ') + Math.abs(savingsRate) + '%', valColor: periodNet>=0?P.green:P.red },
      { label:'Età del denaro', value: aom==null?'—':(aom+' gg'), sub:'copertura spese', valColor:'#8b7cf6' },
    ].map(k => Object.assign({}, k, { valStyle:{ fontFamily:"'JetBrains Mono',monospace", fontWeight:600, fontSize:'21px', marginTop:'6px', color:k.valColor } }));

    // -- Sottopagine Dashboard (una per ogni KPI/report, navigabili dal menu laterale) --
    const dashTabDefs = [
      ['networth','Patrimonio netto'], ['incomeexpense','Entrate vs Uscite'],
      ['spending','Spese per categoria'], ['goals','Obiettivi'],
      ['struggling','Categorie in affanno'], ['fixedvar','Spese fisse vs variabili'],
      ['savings','Risparmio & Età del denaro']
    ];
    const dashSubNavItem = (active) => ({ display:'flex', alignItems:'center', width:'100%', padding:'7px 10px', border:'none', borderRadius:'7px', fontSize:'12.5px', fontWeight: active?600:500, cursor:'pointer', textAlign:'left', background: active?'rgba(91,141,239,0.12)':'transparent', color: active?C.chipBlue:C.t2, transition:'background .12s' });
    const dashSideItems = dashTabDefs.map(x => ({
      key:x[0], label:x[1], onClick:()=>this.goDashTab(x[0]),
      style: dashSubNavItem(st.view==='dashboard' && dash.tab===x[0])
    }));
    const dashChipStyle = (active) => ({ padding:'8px 14px', borderRadius:'999px', border:'1px solid '+(active?'#5b8def':C.b2), background: active?'#5b8def':C.bg1, color: active?'#fff':C.t1, fontSize:'12.5px', fontWeight:'600', cursor:'pointer', whiteSpace:'nowrap', flexShrink:'0' });
    const dashChips = dashTabDefs.map(x => ({
      key:x[0], label:x[1], onClick:()=>this.goDashTab(x[0]),
      style: dashChipStyle(st.view==='dashboard' && dash.tab===x[0])
    }));
    const isDashNetWorth = dash.tab==='networth';
    const isDashSpending = dash.tab==='spending';
    const isDashIncomeExpense = dash.tab==='incomeexpense';
    const isDashGoals = dash.tab==='goals';
    const isDashStruggling = dash.tab==='struggling';
    const isDashFixedVar = dash.tab==='fixedvar';
    const isDashSavings = dash.tab==='savings';

    // ---- Scheda: Patrimonio netto (evoluzione nel tempo + composizione attuale) ----
    const nwVals = dMonths.map(mo => this.nwAt(mo, dAcc));
    const nwMin = Math.min(...nwVals), nwMax = Math.max(...nwVals);
    const nwSpan = (nwMax - nwMin) || 1;
    const nwPts = nwVals.map((v,i) => { const x = dMonths.length>1 ? (i/(dMonths.length-1))*100 : 50; const y = 56 - ((v-nwMin)/nwSpan)*50 - 3; return [x, y]; });
    const nwLinePath = nwPts.map((p,i) => (i===0?'M':'L') + ' ' + p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join(' ');
    const nwAreaPath = nwLinePath + ' L 100 60 L 0 60 Z';
    const nwDots = nwPts.map((p,i) => ({ style:{ position:'absolute', left:p[0]+'%', top:(p[1]/60*100)+'%', width:'7px', height:'7px', marginLeft:'-3.5px', marginTop:'-3.5px', borderRadius:'50%', background:'#5b8def', border:'2px solid '+C.bg2 }, title: this.monthAbbr(dMonths[i]) + ': ' + this.fmtEur(nwVals[i]) }));
    const nwStart = nwVals[0] || 0, nwEnd = nwVals[nwVals.length-1] || 0;
    const nwChange = nwEnd - nwStart;
    const nwTrend = {
      areaPath: nwAreaPath, linePath: nwLinePath, dots: nwDots,
      currentText: this.mask(this.fmtEur(nwEnd)), startLabel: this.monthAbbr(dFromMo), endLabel: this.monthAbbr(dToMo),
      changeText: this.mask((nwChange>=0?'+':'−') + this.fmtEur(Math.abs(nwChange))),
      changeStyle: { fontFamily:"'JetBrains Mono',monospace", fontWeight:700, fontSize:'16px', marginTop:'4px', color: nwChange>=0?P.green:P.red }
    };
    const allocColors = { 'Current Account':'#5b8def','Card':'#8b7cf6','Deposit':'#3ecf8e','Broker':'#e2b341','Pension Fund':'#4bb6c9','Cash':C.t1,'Crypto':'#e08a4b','Other':C.t5 };
    const allocMap={}; st.accounts.forEach(a=>{ const bal=this.accountBalance(a); if(bal>0) allocMap[a.type]=(allocMap[a.type]||0)+bal; });
    const allocKeys = Object.keys(allocMap);
    const allocHasData = allocKeys.length > 0;
    const allocTotal = allocKeys.reduce((s,k)=>s+allocMap[k],0);
    let allocCum=0;
    const allocSegs=allocKeys.sort((a,b)=>allocMap[b]-allocMap[a]).map(k=>{ const val=allocMap[k]; const pv=allocTotal ? (val/allocTotal)*100 : 0; const seg={ type:k, label:this.typeLabelAcc(k), color:allocColors[k]||C.t5, dotStyle:{ width:'9px', height:'9px', borderRadius:'2px', background:allocColors[k]||C.t5, flexShrink:0 }, valueText:this.mask(this.fmtEur(val)), pctText:Math.round(pv)+'%', dash:pv.toFixed(2)+' '+(100-pv).toFixed(2), offset:(25-allocCum).toFixed(2) }; allocCum+=pv; return seg; });
    const allocTotalText=this.mask(this.fmtEur(allocTotal));

    // ---- Composizione per singolo conto (come si dividono i conti tra loro, non solo per tipo) ----
    const allocAccMap = {}; st.accounts.forEach(a=>{ const bal=this.accountBalance(a); if(bal>0) allocAccMap[a.id]=bal; });
    const allocAccKeys = Object.keys(allocAccMap);
    const allocAccHasData = allocAccKeys.length > 0;
    const allocAccTotal = allocAccKeys.reduce((s,k)=>s+allocAccMap[k],0);
    let allocAccCum=0;
    const allocAccSegs = allocAccKeys.sort((a,b)=>allocAccMap[b]-allocAccMap[a]).map((aid,i)=>{
      const acc = st.accounts.find(a=>a.id===aid);
      const val = allocAccMap[aid];
      const pv = allocAccTotal ? (val/allocAccTotal)*100 : 0;
      const seg = { label: acc?acc.name:'—', color: spendPalette[i%spendPalette.length], dotStyle:{ width:'9px', height:'9px', borderRadius:'2px', background:spendPalette[i%spendPalette.length], flexShrink:0 }, valueText:this.mask(this.fmtEur(val)), pctText:Math.round(pv)+'%', dash:pv.toFixed(2)+' '+(100-pv).toFixed(2), offset:(25-allocAccCum).toFixed(2) };
      allocAccCum+=pv;
      return seg;
    });
    const allocAccTotalText = this.mask(this.fmtEur(allocAccTotal));

    // ---- Scheda: Spese (distribuzione delle uscite tra categorie) ----
    const expTxns = st.transactions.filter(t => t.type==='Expense' && dInPeriod(t.date) && (!dAcc || t.accountId===dAcc) && (!dashCatSet || dashCatSet.indexOf(t.categoryId)>-1));
    const byCat = {}; expTxns.forEach(t => { const k=t.categoryId||'__none__'; byCat[k]=(byCat[k]||0)+this.parseNum(t.amount); });
    const totalExp = Object.keys(byCat).reduce((s,k)=>s+byCat[k],0);
    const catArr = Object.keys(byCat).map(k => ({ cid:k, amount:byCat[k] })).sort((a,b)=>b.amount-a.amount);
    const maxCat = Math.max(1, ...catArr.map(c=>c.amount));
    let spendCum=0;
    const spendSegs = catArr.map((c,i) => { const pv = totalExp>0?(c.amount/totalExp)*100:0; const seg={ dash:pv.toFixed(2)+' '+(100-pv).toFixed(2), offset:(25-spendCum).toFixed(2), color: spendPalette[i%spendPalette.length] }; spendCum+=pv; return seg; });
    const spendCats = catArr.map((c,i) => ({
      name: c.cid==='__none__' ? 'Senza categoria' : (catMap[c.cid]?catMap[c.cid].name:'Senza categoria'),
      amountText:this.fmtEur(c.amount),
      pctText: totalExp>0 ? Math.round((c.amount/totalExp)*100)+'%' : '0%',
      dotStyle:{ width:'9px', height:'9px', borderRadius:'2px', background: spendPalette[i%spendPalette.length], flexShrink:0 },
      barStyle:{ width: Math.max(2,(c.amount/maxCat)*100)+'%', height:'100%', background: spendPalette[i%spendPalette.length], borderRadius:'6px', transition:'width .3s' },
      onClick: c.cid==='__none__' ? ()=>{} : ()=>this.drillCategory(c.cid, dFromMo, dToMo, 'Expense')
    }));
    const spendTotalText = this.fmtEur(totalExp);
    const spendEmpty = catArr.length===0;
    const dashGroupOptions = st.groups.map(g=>({ value:g.name, label:g.name }));
    const dashCatSource = dash.groupId ? st.categories.filter(c=>c.type==='Expense' && (c.group||'')===dash.groupId) : st.categories.filter(c=>c.type==='Expense');
    const dashCategoryOptions = dashCatSource.map(c=>({ value:c.id, label:c.name }));
    const dashFilterActive = !!(dash.groupId || dash.categoryId);
    const dashFilterLabel = dash.categoryId ? ((catMap[dash.categoryId]||{}).name||'') : dash.groupId;

    // ---- Scheda: Entrate vs Uscite (confronto mensile + tasso di risparmio) ----
    const maxIE = Math.max(1, ...ieRaw.map(b => Math.max(b.income,b.expense)));
    const ieBars = ieRaw.map(b => { const net=b.income-b.expense; return {
      month:b.mo, label:this.monthAbbr(b.mo),
      title: this.monthAbbr(b.mo) + '  •  Entrate ' + this.fmtEur(b.income) + '  •  Uscite ' + this.fmtEur(b.expense),
      incomeStyle:{ width:'14px', height: Math.max(1.5,(b.income/maxIE)*100)+'%', minHeight:'2px', background:'#3ecf8e', borderRadius:'3px 3px 0 0', transition:'height .3s' },
      expenseStyle:{ width:'14px', height: Math.max(1.5,(b.expense/maxIE)*100)+'%', minHeight:'2px', background:'#f0616d', borderRadius:'3px 3px 0 0', transition:'height .3s' },
      netText: (net>=0?'+':'−') + this.fmtEur(Math.abs(net)),
      netStyle:{ fontFamily:"'JetBrains Mono',monospace", fontSize:'10px', fontWeight:600, color: net>=0?P.green:P.red },
      onClick:()=>this.drillMonth(b.mo)
    }; });
    const ieMonthRates = ieRaw.map(b => b.income>0 ? ((b.income-b.expense)/b.income)*100 : null).filter(v=>v!==null);
    const ieAvgRate = ieMonthRates.length ? Math.round(ieMonthRates.reduce((s,r)=>s+r,0)/ieMonthRates.length) : 0;
    const ieInsight = periodIncome<=0 ? '' :
      ieAvgRate < 0 ? 'In media, in questo periodo spendi più di quanto guadagni.' :
      ieAvgRate < 10 ? 'Il margine di risparmio è ridotto: in media accantoni solo il ' + ieAvgRate + '% delle entrate.' :
      'In media risparmi il ' + ieAvgRate + '% delle entrate ogni mese.';

    // ---- Scheda: Obiettivi (stato dei target di categoria, sempre riferito al mese corrente) ----
    const goalsMonth = this.today().slice(0,7);
    const goalCats = st.categories.filter(c=>c.type==='Expense' && !c.hidden && c.targetType && this.parseNum(c.target)>0);
    const goalRows = goalCats.map(c=>{
      const needed = this.catTargetNeeded(c, goalsMonth);
      const assigned = this.catAssignedMonth(c.id, goalsMonth);
      const funded = assigned+0.005 >= needed;
      const toGo = Math.max(0, needed-assigned);
      const pct = needed>0.005 ? Math.min(100,(assigned/needed)*100) : 100;
      return {
        id:c.id, name:c.name, cadenceText:this.catTargetDueLabel(c), funded, toGo,
        neededText:this.fmtEur(needed), assignedText:this.fmtEur(assigned), toGoText:this.fmtEur(toGo),
        barStyle:{ width:pct+'%', height:'100%', background: funded?'#3ecf8e':'#5b8def', borderRadius:'4px', transition:'width .3s' },
        onClick:()=>this.openCategoryDetail(c.id),
      };
    }).sort((a,b)=> (a.funded===b.funded) ? 0 : (a.funded?1:-1));
    const goalsFundedCount = goalRows.filter(r=>r.funded).length;
    const goalsTotalCount = goalRows.length;
    const goalsEmpty = goalsTotalCount===0;
    const goalsTotalToGoText = this.fmtEur(goalRows.reduce((s,r)=>s+r.toGo, 0));

    // ---- Scheda: Categorie in affanno (quali categorie sforano più spesso nel periodo) ----
    const struggleRows = expenseCatList.map(c=>{
      let overCount=0, overSum=0;
      dMonths.forEach(mo=>{ const avail=this.catAvail(c.id,mo); if(avail<-0.005){ overCount++; overSum += (-avail); } });
      return { id:c.id, name:c.name, overCount, monthsCount:dMonths.length,
        avgOverText:this.fmtEur(overCount>0?overSum/overCount:0), totalOverText:this.fmtEur(overSum),
        onClick:()=>this.drillCategory(c.id, dFromMo, dToMo, 'Expense') };
    }).filter(r=>r.overCount>0).sort((a,b)=> b.overCount-a.overCount);
    const maxOverCount = Math.max(1, ...struggleRows.map(r=>r.overCount));
    const struggleRowsFinal = struggleRows.map(r=> Object.assign({}, r, {
      barStyle:{ width: Math.max(4,(r.overCount/maxOverCount)*100)+'%', height:'100%', background:'#f0616d', borderRadius:'4px' },
      freqText: r.overCount + ' di ' + r.monthsCount + ' mes' + (r.monthsCount===1?'e':'i'),
    }));
    const struggleEmpty = struggleRowsFinal.length===0;

    // ---- Scheda: Spese fisse vs variabili (in base al gruppo marcato come "fisso") ----
    const groupFixedMap = {}; st.groups.forEach(g=>{ groupFixedMap[g.name] = !!g.fixed; });
    const anyGroupTaggedFixed = st.groups.some(g=>g.fixed);
    const fvRaw = dMonths.map(mo=>{
      let fixedAmt=0, varAmt=0;
      st.transactions.forEach(t=>{
        if(t.type==='Expense' && (t.date||'').slice(0,7)===mo && (!dAcc || t.accountId===dAcc)){
          const cat = catMap[t.categoryId];
          const isFixed = !!(cat && groupFixedMap[cat.group||'']);
          if(isFixed) fixedAmt += this.parseNum(t.amount); else varAmt += this.parseNum(t.amount);
        }
      });
      return { mo, fixedAmt, varAmt };
    });
    const fvMax = Math.max(1, ...fvRaw.map(b=>b.fixedAmt+b.varAmt));
    const fvBars = fvRaw.map(b => ({
      label:this.monthAbbr(b.mo),
      title: this.monthAbbr(b.mo) + '  •  Fisse ' + this.fmtEur(b.fixedAmt) + '  •  Variabili ' + this.fmtEur(b.varAmt),
      fixedStyle:{ width:'14px', height: Math.max(1.5,(b.fixedAmt/fvMax)*100)+'%', minHeight:'2px', background:'#5b8def', borderRadius:'3px 3px 0 0', transition:'height .3s' },
      varStyle:{ width:'14px', height: Math.max(1.5,(b.varAmt/fvMax)*100)+'%', minHeight:'2px', background:'#e2b341', borderRadius:'3px 3px 0 0', transition:'height .3s' },
      onClick:()=>this.drillMonth(b.mo),
    }));
    const fvTotalFixed = fvRaw.reduce((s,b)=>s+b.fixedAmt,0);
    const fvTotalVar = fvRaw.reduce((s,b)=>s+b.varAmt,0);
    const fvTotalFixedText = this.fmtEur(fvTotalFixed);
    const fvTotalVarText = this.fmtEur(fvTotalVar);
    const fvPctFixed = (fvTotalFixed+fvTotalVar)>0 ? Math.round((fvTotalFixed/(fvTotalFixed+fvTotalVar))*100) : 0;
    const fvEmpty = (fvTotalFixed+fvTotalVar)===0;

    // ---- Scheda: Risparmio & Età del denaro (tasso di risparmio mese per mese) ----
    const savRates = ieRaw.map(b => ({ mo:b.mo, income:b.income, expense:b.expense, net:b.income-b.expense, rate: b.income>0 ? Math.round(((b.income-b.expense)/b.income)*100) : 0 }));
    const maxAbsRate = Math.max(10, ...savRates.map(r=>Math.abs(r.rate)));
    const savRows = savRates.map(r => ({
      label: this.monthAbbr(r.mo),
      barStyle: { width: Math.max(2,(Math.abs(r.rate)/maxAbsRate)*100)+'%', height:'100%', background: r.rate>=0?P.green:P.red, borderRadius:'4px', transition:'width .3s' },
      rateText: (r.rate>=0?'+':'') + r.rate + '%',
      rateStyle: { fontFamily:"'JetBrains Mono',monospace", fontSize:'12px', fontWeight:600, color: r.rate>=0?P.green:P.red },
      netText: (r.net>=0?'+':'−') + this.fmtEur(Math.abs(r.net)),
      onClick:()=>this.drillMonth(r.mo)
    }));
    const savEmpty = savRates.length===0;
    const bestMonth = savRates.length ? savRates.reduce((a,b)=> b.net>a.net?b:a) : null;
    const worstMonth = savRates.length ? savRates.reduce((a,b)=> b.net<a.net?b:a) : null;
    const avgSavingsRate = savRates.length ? Math.round(savRates.reduce((s,r)=>s+r.rate,0)/savRates.length) : 0;
    const savSummary = [
      { label:'Tasso medio di risparmio', value: avgSavingsRate+'%', color: avgSavingsRate>=0?P.green:P.red },
      { label:'Mese migliore', value: bestMonth ? (this.monthAbbr(bestMonth.mo)+' · '+this.fmtEur(bestMonth.net)) : '—', color:P.green },
      { label:'Mese peggiore', value: worstMonth ? (this.monthAbbr(worstMonth.mo)+' · '+this.fmtEur(worstMonth.net)) : '—', color:P.red },
    ].map(k => Object.assign({}, k, { valStyle:{ fontFamily:"'JetBrains Mono',monospace", fontWeight:600, fontSize:'16.5px', marginTop:'5px', color:k.color } }));

    // TRANSACTIONS
    const f = st.filters;
    let txns = this.filteredTxns();
    const tagBase = { display:'inline-block', maxWidth:'100%', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', verticalAlign:'middle', fontSize:'11.5px', fontWeight:600, padding:'3px 9px', borderRadius:'6px' };
    const txnRows = txns.map(t => {
      const isTransfer = t.type==='Transfer';
      const isIncome = t.type==='Income';
      const cat = catMap[t.categoryId];
      let catName, tagStyle;
      if (isTransfer){ catName='Trasferimento'; tagStyle=Object.assign({},tagBase,{ background:'rgba(91,141,239,0.12)', color:P.accent }); }
      else if (cat){ catName=cat.name; tagStyle=Object.assign({},tagBase,{ background:C.b1, color:P.muted }); }
      else { catName='Senza categoria'; tagStyle=Object.assign({},tagBase,{ background:C.b1, color:P.dim }); }
      let accName = accMap[t.accountId] ? accMap[t.accountId].name : '—';
      if (isTransfer) accName = accName + ' → ' + (accMap[t.toAccountId]?accMap[t.toAccountId].name:'—');
      const amtColor = isTransfer ? P.muted : (isIncome ? P.green : P.text);
      const sign = isIncome ? '+' : (isTransfer ? '' : '−');
      const sub = t.notes || '';
      const clr = t.cleared || (t.reconciled?'reconciled':'uncleared');
      const clrTitle = clr==='reconciled'?'Riconciliato':(clr==='cleared'?'Liquidato':'Non liquidato');
      const clrStyle = clr==='reconciled' ? { width:'8px', height:'8px', borderRadius:'50%', background:'#3ecf8e', flexShrink:0 } : (clr==='cleared' ? { width:'8px', height:'8px', borderRadius:'50%', background:'#5b8def', flexShrink:0 } : { width:'8px', height:'8px', borderRadius:'50%', background:'transparent', border:'1.5px solid '+C.barEmpty, boxSizing:'border-box', flexShrink:0 });
      const selected = !!st.selectedTxnIds[t.id];
      return { id:t.id, dateLabel:this.fmtDate(t.date), description:t.description, subLabel:sub, hasSub:!!sub, categoryName:catName, tagStyle, accountName:accName, clearedStyle:clrStyle, clearedTitle:clrTitle, amountText: sign + ' ' + this.fmtEur(t.amount), amountStyle:{ fontFamily:"'JetBrains Mono',monospace", fontWeight:600, fontSize:'13px', color:amtColor }, onEdit:()=>this.editTransaction(t), onDelete:()=>this.delTransaction(t), selected, onToggleSelect:()=>this.toggleTxnSelect(t.id), rowStyle:{ padding:'12px 16px', borderBottom:'1px solid '+C.b0, display:'flex', flexDirection:'column', gap:'7px', background: selected?'rgba(91,141,239,0.08)':'transparent' } };
    });
    const hasFilters = !!(f.from||f.to||f.accountId||f.categoryId||f.type||f.search);
    const txnIdsVisible = txnRows.map(r=>r.id);
    const selectedTxnCount = Object.keys(st.selectedTxnIds).length;
    const hasTxnSelection = selectedTxnCount>0;
    const allTxnSelected = txnIdsVisible.length>0 && txnIdsVisible.every(id=>st.selectedTxnIds[id]);
    const onToggleSelectAllTxns = ()=>this.toggleSelectAllTxns(txnIdsVisible);
    const onDeleteSelectedTxns = ()=>this.deleteSelectedTxns();
    const onClearTxnSelection = ()=>this.clearTxnSelection();
    const accountFilterOptions = st.accounts.map(a=>({ value:a.id, label:a.name }));
    const categoryFilterOptions = st.categories.map(c=>({ value:c.id, label:c.name + (c.type==='Income'?' (entrata)':'') }));

    // ACCOUNTS
    const typeColors = { 'Current Account':'#5b8def','Card':'#8b7cf6','Deposit':'#3ecf8e','Broker':'#e2b341','Pension Fund':'#4bb6c9','Cash':C.t1,'Crypto':'#e08a4b','Other':C.t5 };
    const accountCards = st.accounts.map((a, idx) => {
      const bal = this.accountBalance(a);
      const col = typeColors[a.type] || P.dim;
      const onB = a.onBudget!==false;
      const shown = a.showInNewTransactions!==false;
      return { id:a.id, name:a.name, bank:a.bank, typeLabel:this.typeLabelAcc(a.type), balanceText:this.mask(this.fmtEur(bal)), initialText:this.mask(this.fmtEur(a.initialBalance)), balanceStyle:{ fontFamily:"'JetBrains Mono',monospace", fontWeight:600, fontSize:'23px', marginTop:'3px', color: bal<0?P.red:P.text }, typeBadgeStyle:{ fontSize:'11px', fontWeight:600, padding:'3px 9px', borderRadius:'6px', background:'rgba(255,255,255,0.04)', color:col, border:'1px solid '+col+'33' }, budgetBadgeLabel: onB?'Nel budget':'Tracking', budgetBadgeStyle:{ fontSize:'11px', fontWeight:600, padding:'3px 9px', borderRadius:'6px', background: onB?'rgba(62,207,142,0.1)':'rgba(146,151,161,0.1)', color: onB?'#3ecf8e':C.t1, border:'1px solid '+(onB?'rgba(62,207,142,0.25)':'rgba(146,151,161,0.22)') }, showTxnBadgeLabel: shown?'Nuovi movimenti':'Nascosto dai nuovi', showTxnBadgeStyle:{ fontSize:'11px', fontWeight:600, padding:'3px 9px', borderRadius:'6px', background: shown?'rgba(91,141,239,0.1)':'rgba(240,97,109,0.08)', color: shown?C.chipBlue:'#f0616d', border:'1px solid '+(shown?'rgba(91,141,239,0.25)':'rgba(240,97,109,0.22)') }, moveUpDisabled: idx===0, moveDownDisabled: idx===st.accounts.length-1, moveBtnStyle:{ width:'28px', height:'28px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'7px', color:C.t2, cursor:'pointer' }, onMoveUp:()=>this.moveAccount(a.id,-1), onMoveDown:()=>this.moveAccount(a.id,1), onEdit:()=>this.editAccount(a), onDelete:()=>this.delAccount(a) };
    });

    // CATEGORIES
    const incomeCats = st.categories.filter(c=>c.type==='Income').map(c=>({ id:c.id, name:c.name, onEdit:()=>this.editCategory(c), onDelete:()=>this.delCategory(c) }));
    const groupNamesCat = this.expenseGroupOrder();
    const expenseGroups = groupNamesCat.map(g=>({
      name: g||'Senza gruppo', isReal: !!g,
      cats: st.categories.filter(c=>c.type==='Expense' && !c.hidden && (c.group||'')===g).map(c=>({ id:c.id, name:c.name, targetText: c.target? ('Obiettivo '+this.fmtEur(c.target)):'', hasTarget:!!(c.target), onEdit:()=>this.editCategory(c), onDelete:()=>this.delCategory(c) })),
      onEditGroup: g ? (()=>this.editGroup(g)) : (()=>{}),
      onDeleteGroup: g ? (()=>this.delGroup(g)) : (()=>{})
    })).map(gr=>Object.assign(gr,{ isEmptyReal: gr.isReal && gr.cats.length===0 })).filter(gr => !(gr.cats.length===0 && !gr.isReal));
    const hiddenCats = st.categories.filter(c=>c.type==='Expense' && c.hidden).map(c=>({ id:c.id, name:c.name, onShow:()=>this.toggleHideCategory(c.id,false), onDelete:()=>this.delCategory(c) }));
    const existingGroups = st.groups.map(x=>x.name);

    // PAGINA DETTAGLIO CATEGORIA
    const detailCat = st.detailCategoryId ? st.categories.find(c=>c.id===st.detailCategoryId) : null;
    let categoryDetail = null;
    if(detailCat){
      const month = st.month;
      const carry = this.catCarryover(detailCat.id, month);
      const assigned = this.catAssignedMonth(detailCat.id, month);
      const spent = this.catSpentMonth(detailCat.id, month);
      const avail = carry + assigned - spent;
      const target = this.parseNum(detailCat.target);
      const hasTarget = !!(detailCat.targetType && target>0);
      const neededThisMonth = hasTarget ? this.catTargetNeeded(detailCat, month) : 0;
      const toGo = Math.max(0, neededThisMonth - assigned);
      const funded = hasTarget && assigned+0.005 >= neededThisMonth;
      const snoozed = (detailCat.snoozedMonths||[]).indexOf(month) > -1;
      const stats = this.catHistoryStats(detailCat.id, month);
      const noteVal = st.noteEdits.hasOwnProperty(detailCat.id) ? st.noteEdits[detailCat.id] : ((st.categoryNotes.find(n=>n.categoryId===detailCat.id && n.month===month)||{}).text || '');
      const prevAbbrIdx = parseInt(this.addMonth(month,-1).split('-')[1],10)-1;
      categoryDetail = {
        id: detailCat.id, name: detailCat.name,
        fromPrevLabel: 'Da ' + this.monthAbbrArr[prevAbbrIdx],
        fromPrevText: this.fmtEur(carry),
        assignedText: this.fmtEur(assigned),
        activityText: spent>0 ? ('-'+this.fmtEur(spent)) : this.fmtEur(0),
        availText: this.fmtEur(avail),
        availColor: avail<-0.005 ? P.red : (avail>0.005?P.green:C.t2),
        hasTarget, targetFunded: funded, snoozed,
        targetAmountText: this.fmtEur(target),
        targetDueLabel: this.catTargetDueLabel(detailCat),
        neededThisMonthText: this.fmtEur(neededThisMonth),
        assignedSoFarText: this.fmtEur(assigned),
        toGoText: this.fmtEur(toGo),
        noteVal, stats,
        onClose: ()=>this.closeCategoryDetail(),
        onToggleStats: ()=>this.toggleStatsPopover(),
        onOpenTarget: ()=>this.openTargetEditor(detailCat.id),
        onToggleSnooze: ()=>this.toggleSnoozeThisMonth(detailCat.id),
        onNote: (e)=>this.onCategoryNote(detailCat.id, e),
        onNoteBlur: (e)=>this.onCategoryNoteBlur(detailCat.id, e),
        onAddTransaction: ()=>{ this.closeCategoryDetail(); this.openModal('transaction','create',{ type:'Expense', date:this.today(), description:'', accountId:(this.accountsForNewTransactions()[0]||{}).id||'', toAccountId:'', categoryId:detailCat.id, amount:'', notes:'', cleared:'uncleared' }); },
        onActivity: ()=>this.goToCategoryActivity(detailCat.id),
        onRename: ()=>{ this.closeCategoryDetail(); this.editCategory(detailCat); },
        onHide: ()=>this.toggleHideCategory(detailCat.id, true),
        onDelete: ()=>{ this.closeCategoryDetail(); this.delCategory(detailCat); },
      };
    }

    // EDITOR OBIETTIVO
    const te = st.targetEditor;
    let targetEditorVM = null;
    if(te){
      const dayOptions = Array.from({length:31},(_,i)=>({ value:String(i+1), label:String(i+1) }));
      const weekdayOptions = ['Domenica','Lunedì','Martedì','Mercoledì','Giovedì','Venerdì','Sabato'].map((n,i)=>({ value:String(i), label:n }));
      targetEditorVM = {
        type: te.type, amount: te.amount, day: te.day, date: te.date, repeat: te.repeat,
        dayOptions, weekdayOptions,
        onAmount:(e)=>this.setTargetEditorField({ amount:e.target.value }),
        onDay:(e)=>this.setTargetEditorField({ day:e.target.value }),
        onDate:(e)=>this.setTargetEditorField({ date:e.target.value }),
        onToggleRepeat:()=>this.setTargetEditorField({ repeat:!te.repeat }),
        setTypeWeekly:()=>this.setTargetEditorField({ type:'weekly' }),
        setTypeMonthly:()=>this.setTargetEditorField({ type:'monthly' }),
        setTypeYearly:()=>this.setTargetEditorField({ type:'yearly' }),
        setTypeCustom:()=>this.setTargetEditorField({ type:'custom' }),
        onSave:()=>this.saveTargetEditor(),
        onDelete:()=>this.deleteTargetEditor(),
        onClose:()=>this.closeTargetEditor(),
        hasExistingTarget: !!((this.state.categories.find(c=>c.id===te.categoryId)||{}).targetType),
      };
    }

    // MODAL
    const m = st.modal; const d = m.data || {};
    const isTransactionModal = m.kind==='transaction';
    const isTransferModal = isTransactionModal && d.type==='Transfer';
    const showCategoryField = isTransactionModal && d.type!=='Transfer';
    const modalTitles = { account: m.mode==='edit'?'Modifica conto':'Nuovo conto', transaction: m.mode==='edit'?'Modifica movimento':'Nuovo movimento', category: m.mode==='edit'?'Modifica categoria':'Nuova categoria', group: m.mode==='edit'?'Modifica gruppo':'Nuovo gruppo', import:'Importa movimenti', move:'Sposta fondi' };
    const saveLabel = m.kind==='import' ? 'Importa' : (m.kind==='move' ? 'Sposta' : 'Salva');
    const accountTypeOptions = this.accountTypes.map(x=>({ value:x[0], label:x[1] }));
    const modalAccountSource = isTransactionModal ? st.accounts.filter(a => a.showInNewTransactions!==false || a.id===d.accountId || a.id===d.toAccountId) : st.accounts;
    const modalAccountOptions = modalAccountSource.map(a=>({ value:a.id, label:a.name }));
    const modalCatSource = d.type==='Income' ? st.categories.filter(c=>c.type==='Income') : st.categories.filter(c=>c.type==='Expense');
    const modalCategoryOptions = modalCatSource.map(c=>({ value:c.id, label:c.name }));
    const segBtn = (active) => ({ flex:1, padding:'8px', border:'none', borderRadius:'7px', fontSize:'12.5px', fontWeight:600, cursor:'pointer', background: active?'#5b8def':'transparent', color: active?'#fff':C.t1, transition:'all .12s' });
    const typeBtn = { income:segBtn(d.type==='Income'), expense:segBtn(d.type==='Expense'), transfer:segBtn(d.type==='Transfer') };
    const isExpenseCatModal = m.kind==='category' && d.type==='Expense';
    const clrSeg = (active,col) => ({ flex:1, padding:'8px', border:'none', borderRadius:'7px', fontSize:'12px', fontWeight:600, cursor:'pointer', background: active?col:'transparent', color: active?'#fff':C.t1, transition:'all .12s' });
    const clearedBtn = { uncleared:clrSeg((d.cleared||'uncleared')==='uncleared',C.t2), cleared:clrSeg(d.cleared==='cleared','#5b8def'), reconciled:clrSeg(d.cleared==='reconciled','#3ecf8e') };
    const isMoveModal = m.kind==='move';
    const moveFromCat = isMoveModal ? this.state.categories.find(x=>x.id===d.fromCategoryId) : null;
    const moveFromAvail = isMoveModal && moveFromCat ? this.catAvail(moveFromCat.id, st.month) : 0;
    const moveFromName = moveFromCat ? moveFromCat.name : '';
    const moveFromAvailText = this.fmtEur(moveFromAvail);
    const moveToOptions = isMoveModal ? expenseCatList.filter(c=>c.id!==d.fromCategoryId).map(c=>({ value:c.id, label:c.name+' · disp. '+this.fmtEur(this.catAvail(c.id, st.month)) })) : [];

    // SPOSTA FONDI (schermata dedicata stile YNAB, con ricerca categorie)
    let moveMoneyVM = null;
    if(st.moveMoney){
      const mv = st.moveMoney;
      const fromCat = st.categories.find(c=>c.id===mv.fromCategoryId);
      const fromAvailNow = fromCat ? this.catAvail(fromCat.id, st.month) : 0;
      const isReadyTarget = mv.toCategoryId === '__ready__';
      const toCat = (mv.toCategoryId && !isReadyTarget) ? st.categories.find(c=>c.id===mv.toCategoryId) : null;
      const search = (mv.search||'').trim().toLowerCase();
      const pickerGroups = this.expenseGroupOrder().map(g => ({
        name: g || 'Senza gruppo',
        cats: expenseCatList
          .filter(c => c.id!==mv.fromCategoryId && (c.group||'')===g && (!search || c.name.toLowerCase().indexOf(search)>-1))
          .map(c => ({ id:c.id, name:c.name, availText:this.fmtEur(this.catAvail(c.id, st.month)), onClick:()=>this.selectMoveTarget(c.id) }))
      })).filter(gr => gr.cats.length>0);
      const readyMatches = !search || 'pronto per assegnare'.indexOf(search)>-1;
      moveMoneyVM = {
        fromName: fromCat ? fromCat.name : '',
        fromAvailText: this.fmtEur(fromAvailNow),
        amount: mv.amount, onAmount:(e)=>this.setMoveMoneyField({ amount:e.target.value }),
        hasTarget: !!mv.toCategoryId,
        toLabel: isReadyTarget ? 'Pronto per assegnare' : (toCat ? toCat.name : ''),
        toAvailText: isReadyTarget ? readyText : (toCat ? this.fmtEur(this.catAvail(toCat.id, st.month)) : ''),
        pickerOpen: mv.pickerOpen, search: mv.search,
        onSearch:(e)=>this.setMoveMoneyField({ search:e.target.value }),
        onOpenPicker:()=>this.openMovePicker(), onClosePicker:()=>this.closeMovePicker(),
        readyToAssignText: readyText, readyMatches,
        onSelectReady:()=>this.selectMoveTarget('__ready__'),
        pickerGroups,
        onClose:()=>this.closeMoveMoney(),
        onDone:()=>this.commitMoveMoney(),
        canDone: !!mv.toCategoryId && this.parseNum(mv.amount)>0,
      };
    }

    return {
      // layout
      sidebarStyle, navStyle, isMobile:st.isMobile, showScrim: false,
      isLight, C, rootBg:C.bg0, rootText:C.t0, onToggleTheme:()=>this.toggleTheme(),
      privacyMode: st.privacyMode, onTogglePrivacy:()=>this.togglePrivacy(),
      toggleDrawer:()=>this.setState({ drawerOpen:!st.drawerOpen }), closeDrawer:()=>this.setState({ drawerOpen:false }),
      onMenu:()=> st.isMobile ? this.setState({ mobileMoreOpen:!st.mobileMoreOpen }) : this.setState({ collapsed:!st.collapsed }),
      menuTitle: st.isMobile ? 'Altro' : (st.collapsed ? 'Espandi barra laterale' : 'Comprimi barra laterale'),
      mobileMoreOpen: st.mobileMoreOpen, closeMobileMore:()=>this.setState({ mobileMoreOpen:false }),
      onToggleThemeMobile:()=>{ this.toggleTheme(); this.setState({ mobileMoreOpen:false }); },
      onLogoutMobile:()=>{ this.setState({ mobileMoreOpen:false }); this.logout(); },
      goBudget:()=>this.go('budget'), goTransactions:()=>this.go('transactions'), goAccounts:()=>this.go('accounts'), goCategories:()=>this.go('categories'),
      netWorthStyle, totalNetWorthText:this.mask(this.fmtEur(netWorth)), accountsCountText: st.accounts.length + ' cont' + (st.accounts.length===1?'o':'i'),
      onLogout:()=>this.logout(),
      navTitle, navSubtitle, primaryLabel, onPrimary,
      isBudget:st.view==='budget', isTransactions:st.view==='transactions', isAccounts:st.view==='accounts', isCategories:st.view==='categories',
      isDashboard:st.view==='dashboard', goDashboard:()=>this.go('dashboard'),
      // dashboard / report (unificati)
      dashRangeBtns, dashPeriodLabel, dashAccountOptions, dashAccountId:dash.accountId, onDashAccount:(e)=>this.setDashAccount(e),
      dashCustomOpen, dashCustomFrom, dashCustomTo, onDashCustomFrom, onDashCustomTo,
      dashSideItems, dashChips, isDashNetWorth, isDashSpending, isDashIncomeExpense, isDashGoals, isDashStruggling, isDashFixedVar, isDashSavings,
      kpis, nwTrend, allocSegs, allocTotalText, allocHasData, allocAccSegs, allocAccTotalText, allocAccHasData,
      spendCats, spendSegs, spendEmpty, spendTotalText,
      dashGroupOptions, dashCategoryOptions, dashGroupId:dash.groupId, dashCategoryId:dash.categoryId, onDashGroup:(e)=>this.setDashGroup(e), onDashCategory:(e)=>this.setDashCategory(e), dashFilterActive, dashFilterLabel, clearDashFilter:()=>this.clearDashFilter(),
      ieBars, ieInsight,
      goalRows, goalsFundedCount, goalsTotalCount, goalsEmpty, goalsTotalToGoText,
      struggleRowsFinal, struggleEmpty,
      fvBars, fvTotalFixedText, fvTotalVarText, fvPctFixed, fvEmpty, anyGroupTaggedFixed,
      savRows, savSummary, savEmpty,
      // budget
      monthLabel:this.monthLabel(st.month), onPrevMonth:()=>this.setState({month:this.addMonth(st.month,-1)}), onNextMonth:()=>this.setState({month:this.addMonth(st.month,1)}), onResetBudgets:()=>this.resetBudgets(),
      readyCardStyle, readyLabel, readyText, readyWarning, readyZero, readySubtext, budgetGroups, budgetEmpty: expenseCatList.length===0,
      budgetKeypad: st.budgetKeypad, budgetKeypadCat: st.budgetKeypad ? st.categories.find(c=>c.id===st.budgetKeypad.categoryId) : null,
      budgetKeypadHasTarget: !!(st.budgetKeypad && st.categories.find(c=>c.id===st.budgetKeypad.categoryId) && this.parseNum(st.categories.find(c=>c.id===st.budgetKeypad.categoryId).target)>0),
      budgetKeypadStats: st.budgetKeypad ? this.catHistoryStats(st.budgetKeypad.categoryId, st.month) : null,
      statsPopoverOpen: st.statsPopoverOpen,
      kpDisplayText: st.budgetKeypad ? this.kpDisplay(st.budgetKeypad.entryDigits) : '0,00',
      onKpDigit:(d)=>this.kpDigit(d), onKpBackspace:()=>this.kpBackspace(), onKpClear:()=>this.kpClear(), onKpOpPlus:()=>this.kpOp('+'), onKpOpMinus:()=>this.kpOp('-'), onKpEquals:()=>this.kpEquals(), onKpAutoAssign:()=>this.kpAutoAssign(), onKpMoveMoney:()=>this.kpMoveMoney(), onKpDone:()=>this.kpDone(), onKpClose:()=>this.closeBudgetKeypad(), onKpToggleStats:()=>this.onKpToggleStats(),
      categoryDetail, targetEditorVM, moveMoneyVM,
      // transactions
      filters:st.filters, onFilter:(e)=>this.onFilterChange(e), clearFilters:()=>this.clearFilters(), hasFilters,
      accountFilterOptions, categoryFilterOptions, txnRows, txnEmpty: txnRows.length===0, emptyFilterSuffix: hasFilters?' con questi filtri':'',
      selectedTxnCount, hasTxnSelection, allTxnSelected, onToggleSelectAllTxns, onDeleteSelectedTxns, onClearTxnSelection,
      onExportCsv:()=>this.exportCsv(), onImportCsv:()=>this.openImport(),
      // accounts
      accountCards, accountsEmpty: accountCards.length===0,
      // categories
      incomeCats, expenseGroups, existingGroups, hiddenCats, incomeEmpty:incomeCats.length===0, expenseEmpty:expenseGroups.length===0,
      onNewIncomeCat:()=>this.newCategory('Income'), onNewExpenseCat:()=>this.newCategory('Expense'), onNewGroup:()=>this.newGroup(),
      // modal
      modalOpen:m.open, modalTitle:modalTitles[m.kind]||'', modalKind:m.kind,
      isAccountModal:m.kind==='account', isTransactionModal, isCategoryModal:m.kind==='category', isGroupModal:m.kind==='group',
      isTransferModal, isMoveModal, moveFromName, moveFromAvailText, moveToOptions, showCategoryField, accountFieldLabel: isTransferModal?'Conto di origine':'Conto',
      data:d, onField:(e)=>this.onField(e), onSave:()=>this.saveModal(), onClose:()=>this.closeModal(),
      onBackdrop:(e)=>{ if(!e.target.closest('[data-modal-card]')) this.closeModal(); },
      accountTypeOptions, modalAccountOptions, modalCategoryOptions, typeBtn,
      isExpenseCatModal, clearedBtn, setClearedUncleared:()=>this.setCleared('uncleared'), setClearedCleared:()=>this.setCleared('cleared'), setClearedReconciled:()=>this.setCleared('reconciled'),
      isImportModal: m.kind==='import', saveLabel, onImportFile:(e)=>this.onImportFile(e), onDownloadTemplate:()=>this.downloadTemplate(), importHasFile: !!(d.fileName), importFileName: d.fileName,
      setTypeIncome:()=>this.setTxnType('Income'), setTypeExpense:()=>this.setTxnType('Expense'), setTypeTransfer:()=>this.setTxnType('Transfer'),
      canDelete: m.open && m.mode==='edit', onModalDelete:()=>this.deleteFromModal(),
    };
  }
  renderLogin(){
    const { username, password, remember, error, busy, mode, info, newPassword, newPassword2 } = this.state.auth;
    const C = this.getPalette(this.state.theme);
    const labelStyle = { display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600', marginBottom:'14px' };
    const inputStyle = { padding:'10px 12px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, fontSize:'14px' };
    return (
      <div style={{minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:C.bg0, color:C.t0, fontFamily:"'Hanken Grotesk',system-ui,-apple-system,sans-serif", padding:'20px'}}>
        <form onSubmit={(e)=> mode==='forgot' ? this.submitForgotPassword(e) : (mode==='reset' ? this.submitResetPassword(e) : this.submitLogin(e))} style={{width:'100%', maxWidth:'360px', background:C.bg2, border:'1px solid '+C.b1, borderRadius:'16px', padding:'28px'}}>
          <div style={{display:'flex', alignItems:'center', gap:'10px', marginBottom:'22px'}}>
            <div style={{width:'34px', height:'34px', borderRadius:'9px', background:'linear-gradient(140deg,#5b8def,#3d6fd6)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:'0'}}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round"><path d="M4 18V9M9 18V5M14 18v-6M19 18v-9" /></svg>
            </div>
            <div style={{lineHeight:'1.15'}}>
              <div style={{fontWeight:'700', fontSize:'16px', letterSpacing:'-0.2px'}}>Finanza Personale</div>
              <div style={{fontSize:'12px', color:C.t2}}>{mode==='forgot' ? 'Recupera la password' : (mode==='reset' ? 'Imposta una nuova password' : 'Accedi al cloud')}</div>
            </div>
          </div>

          {(mode==='login') ? (<React.Fragment>
            <label style={labelStyle}>Email
              <input type="email" autoCapitalize="none" autoCorrect="off" value={username} onChange={(e)=>this.onAuthUsername(e)} style={inputStyle} />
            </label>
            <label style={Object.assign({}, labelStyle, { marginBottom:'6px' })}>Password
              <input type="password" value={password} onChange={(e)=>this.onAuthPassword(e)} style={inputStyle} />
            </label>
            <div style={{textAlign:'right', marginBottom:'4px'}}>
              <button type="button" onClick={()=>this.showForgotPassword()} style={{background:'none', border:'none', color:'#5b8def', fontSize:'12px', fontWeight:'600', cursor:'pointer', padding:'0'}}>Password dimenticata?</button>
            </div>
            <label style={{display:'flex', alignItems:'center', gap:'8px', fontSize:'12.5px', color:C.t1, margin:'10px 0 6px', cursor:'pointer'}}>
              <input type="checkbox" checked={remember} onChange={(e)=>this.onAuthRemember(e)} style={{width:'15px', height:'15px', accentColor:'#5b8def'}} />
              Ricorda il nome utente su questo dispositivo
            </label>
            {error ? (<div style={{marginTop:'10px', padding:'9px 12px', background:'rgba(240,97,109,0.1)', border:'1px solid rgba(240,97,109,0.3)', borderRadius:'9px', color:'#f0616d', fontSize:'12.5px', fontWeight:'600'}}>{error}</div>) : null}
            <button type="submit" disabled={busy} style={{width:'100%', marginTop:'18px', padding:'11px', background: busy ? '#3d6fd6' : '#5b8def', border:'none', borderRadius:'9px', color:'#fff', fontSize:'14px', fontWeight:'700', cursor: busy ? 'default' : 'pointer'}}>{busy ? 'Accesso in corso…' : 'Accedi'}</button>
            <p style={{margin:'16px 0 0', fontSize:'11px', color:C.t3, lineHeight:'1.5'}}>I dati sono salvati nel tuo account Supabase e sincronizzati tra i dispositivi dopo il login.</p>
          </React.Fragment>) : null}

          {(mode==='forgot') ? (<React.Fragment>
            <p style={{margin:'0 0 16px', fontSize:'12.5px', color:C.t2, lineHeight:'1.5'}}>Inserisci l'email del tuo account: se registrata, ti mandiamo un link per reimpostare la password.</p>
            <label style={labelStyle}>Email
              <input type="email" autoCapitalize="none" autoCorrect="off" value={username} onChange={(e)=>this.onAuthUsername(e)} style={inputStyle} />
            </label>
            {error ? (<div style={{marginTop:'4px', padding:'9px 12px', background:'rgba(240,97,109,0.1)', border:'1px solid rgba(240,97,109,0.3)', borderRadius:'9px', color:'#f0616d', fontSize:'12.5px', fontWeight:'600'}}>{error}</div>) : null}
            {info ? (<div style={{marginTop:'4px', padding:'9px 12px', background:'rgba(62,207,142,0.1)', border:'1px solid rgba(62,207,142,0.3)', borderRadius:'9px', color:'#3ecf8e', fontSize:'12.5px', fontWeight:'600'}}>{info}</div>) : null}
            <button type="submit" disabled={busy} style={{width:'100%', marginTop:'18px', padding:'11px', background: busy ? '#3d6fd6' : '#5b8def', border:'none', borderRadius:'9px', color:'#fff', fontSize:'14px', fontWeight:'700', cursor: busy ? 'default' : 'pointer'}}>{busy ? 'Invio in corso…' : 'Invia link di reset'}</button>
            <button type="button" onClick={()=>this.showLoginForm()} style={{width:'100%', marginTop:'10px', padding:'10px', background:'none', border:'1px solid '+C.b2, borderRadius:'9px', color:C.t1, fontSize:'13px', fontWeight:'600', cursor:'pointer'}}>Torna al login</button>
          </React.Fragment>) : null}

          {(mode==='reset') ? (<React.Fragment>
            <p style={{margin:'0 0 16px', fontSize:'12.5px', color:C.t2, lineHeight:'1.5'}}>Scegli una nuova password per il tuo account.</p>
            <label style={labelStyle}>Nuova password
              <input type="password" value={newPassword} onChange={(e)=>this.onNewPassword(e)} style={inputStyle} />
            </label>
            <label style={labelStyle}>Ripeti la nuova password
              <input type="password" value={newPassword2} onChange={(e)=>this.onNewPassword2(e)} style={inputStyle} />
            </label>
            {error ? (<div style={{marginTop:'4px', padding:'9px 12px', background:'rgba(240,97,109,0.1)', border:'1px solid rgba(240,97,109,0.3)', borderRadius:'9px', color:'#f0616d', fontSize:'12.5px', fontWeight:'600'}}>{error}</div>) : null}
            <button type="submit" disabled={busy} style={{width:'100%', marginTop:'18px', padding:'11px', background: busy ? '#3d6fd6' : '#5b8def', border:'none', borderRadius:'9px', color:'#fff', fontSize:'14px', fontWeight:'700', cursor: busy ? 'default' : 'pointer'}}>{busy ? 'Salvataggio…' : 'Imposta nuova password'}</button>
          </React.Fragment>) : null}
        </form>
      </div>
    );
  }

  render(){
    if(!this.state.auth.loggedIn){ return this.renderLogin(); }
    const v = this.buildViewModel();
    const {
      sidebarStyle,
      navStyle,
      isMobile,
      showScrim,
      isLight,
      C,
      rootBg,
      rootText,
      onToggleTheme,
      privacyMode,
      onTogglePrivacy,
      toggleDrawer,
      closeDrawer,
      onMenu,
      menuTitle,
      mobileMoreOpen,
      closeMobileMore,
      onToggleThemeMobile,
      onLogoutMobile,
      goBudget,
      goTransactions,
      goAccounts,
      goCategories,
      netWorthStyle,
      totalNetWorthText,
      accountsCountText,
      onLogout,
      navTitle,
      navSubtitle,
      primaryLabel,
      onPrimary,
      isBudget,
      isTransactions,
      isAccounts,
      isCategories,
      isDashboard,
      goDashboard,
      dashRangeBtns,
      dashPeriodLabel,
      dashCustomOpen,
      dashCustomFrom,
      dashCustomTo,
      onDashCustomFrom,
      onDashCustomTo,
      dashAccountOptions,
      dashAccountId,
      onDashAccount,
      dashSideItems,
      dashChips,
      isDashNetWorth,
      isDashSpending,
      isDashIncomeExpense,
      isDashGoals,
      isDashStruggling,
      isDashFixedVar,
      isDashSavings,
      kpis,
      nwTrend,
      allocSegs,
      allocTotalText,
      allocHasData,
      allocAccSegs,
      allocAccTotalText,
      allocAccHasData,
      spendCats,
      spendSegs,
      spendEmpty,
      spendTotalText,
      dashGroupOptions,
      dashCategoryOptions,
      dashGroupId,
      dashCategoryId,
      onDashGroup,
      onDashCategory,
      dashFilterActive,
      dashFilterLabel,
      clearDashFilter,
      ieBars,
      ieInsight,
      goalRows,
      goalsFundedCount,
      goalsTotalCount,
      goalsEmpty,
      goalsTotalToGoText,
      struggleRowsFinal,
      struggleEmpty,
      fvBars,
      fvTotalFixedText,
      fvTotalVarText,
      fvPctFixed,
      fvEmpty,
      anyGroupTaggedFixed,
      savRows,
      savSummary,
      savEmpty,
      monthLabel,
      onPrevMonth,
      onNextMonth,
      onResetBudgets,
      readyCardStyle,
      readyLabel,
      readyText,
      readyWarning,
      readyZero,
      readySubtext,
      budgetGroups,
      budgetEmpty,
      budgetKeypad,
      budgetKeypadCat,
      budgetKeypadHasTarget,
      budgetKeypadStats,
      statsPopoverOpen,
      kpDisplayText,
      onKpDigit,
      onKpBackspace,
      onKpClear,
      onKpOpPlus,
      onKpOpMinus,
      onKpEquals,
      onKpAutoAssign,
      onKpMoveMoney,
      onKpDone,
      onKpClose,
      onKpToggleStats,
      categoryDetail,
      targetEditorVM,
      moveMoneyVM,
      filters,
      onFilter,
      clearFilters,
      hasFilters,
      accountFilterOptions,
      categoryFilterOptions,
      txnRows,
      txnEmpty,
      emptyFilterSuffix,
      selectedTxnCount,
      hasTxnSelection,
      allTxnSelected,
      onToggleSelectAllTxns,
      onDeleteSelectedTxns,
      onClearTxnSelection,
      onExportCsv,
      onImportCsv,
      accountCards,
      accountsEmpty,
      incomeCats,
      expenseGroups,
      existingGroups,
      hiddenCats,
      incomeEmpty,
      expenseEmpty,
      onNewIncomeCat,
      onNewExpenseCat,
      onNewGroup,
      modalOpen,
      modalTitle,
      modalKind,
      isAccountModal,
      isTransactionModal,
      isCategoryModal,
      isGroupModal,
      isTransferModal,
      isMoveModal,
      moveFromName,
      moveFromAvailText,
      moveToOptions,
      showCategoryField,
      accountFieldLabel,
      data,
      onField,
      onSave,
      onClose,
      onBackdrop,
      accountTypeOptions,
      modalAccountOptions,
      modalCategoryOptions,
      typeBtn,
      isExpenseCatModal,
      clearedBtn,
      setClearedUncleared,
      setClearedCleared,
      setClearedReconciled,
      isImportModal,
      saveLabel,
      onImportFile,
      onDownloadTemplate,
      importHasFile,
      importFileName,
      setTypeIncome,
      setTypeExpense,
      setTypeTransfer,
      canDelete,
      onModalDelete
    } = v;
    return (
<React.Fragment><style>{`@media (max-width: 860px){ input, select, textarea { font-size: 16px !important; } }`}</style><div style={{display:'flex', minHeight:'100vh', background:rootBg, color:rootText, fontFamily:'\'Hanken Grotesk\',system-ui,-apple-system,sans-serif', fontSize:'14px', WebkitFontSmoothing:'antialiased', transition:'background .15s, color .15s'}}>{(showScrim) ? (<React.Fragment><div onClick={closeDrawer} style={{position:'fixed', inset:'0', background:'rgba(0,0,0,0.55)', zIndex:'40', animation:'fpOverlay .2s ease'}}></div></React.Fragment>) : null}{(!isMobile) ? (<React.Fragment><aside style={sidebarStyle}><div style={{display:'flex', alignItems:'center', gap:'10px', padding:'4px 6px 20px'}}><div style={{width:'30px', height:'30px', borderRadius:'8px', background:'linear-gradient(140deg,#5b8def,#3d6fd6)', display:'flex', alignItems:'center', justifyContent:'center', boxShadow:'0 2px 10px rgba(91,141,239,0.35)'}}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round"><path d="M4 18V9M9 18V5M14 18v-6M19 18v-9" /></svg></div><div style={{lineHeight:'1.1'}}><div style={{fontWeight:'700', fontSize:'14.5px', letterSpacing:'-0.2px'}}>Finanza</div><div style={{fontSize:'11px', color:C.t2, fontWeight:'500'}}>Personale</div></div></div><nav style={{display:'flex', flexDirection:'column', gap:'2px'}}><button onClick={goDashboard} style={navStyle.dashboard}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="8" height="10" rx="1.5" /><rect x="13" y="3" width="8" height="6" rx="1.5" /><rect x="3" y="15" width="8" height="6" rx="1.5" /><rect x="13" y="11" width="8" height="10" rx="1.5" /></svg><span>Dashboard</span></button>{(isDashboard) ? (<React.Fragment><div style={{display:'flex', flexDirection:'column', gap:'1px', margin:'2px 0 6px 14px', paddingLeft:'13px', borderLeft:'1px solid '+C.b2}}>{(dashSideItems || []).map((d, dIdx) => (<React.Fragment key={dIdx}><button onClick={d.onClick} style={d.style}>{d.label}</button></React.Fragment>))}</div></React.Fragment>) : null}<button onClick={goBudget} style={navStyle.budget}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></svg><span>Budget</span></button><button onClick={goTransactions} style={navStyle.transactions}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="13" y2="17" /></svg><span>Movimenti</span></button><button onClick={goAccounts} style={navStyle.accounts}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="6" width="18" height="12" rx="2" /><line x1="3" y1="10.5" x2="21" y2="10.5" /></svg><span>Conti</span></button><button onClick={goCategories} style={navStyle.categories}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></svg><span>Categorie</span></button></nav><div style={{marginTop:'auto', paddingTop:'16px'}}><div style={{background:C.bg1, border:'1px solid '+C.b2, borderRadius:'12px', padding:'14px'}}><div style={{display:'flex', alignItems:'center', justifyContent:'space-between'}}><div style={{fontSize:'11px', color:C.t2, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.5px'}}>Patrimonio netto</div><button onClick={onTogglePrivacy} title={privacyMode ? 'Mostra importi' : 'Nascondi importi'} style={{width:'22px', height:'22px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'none', borderRadius:'6px', color:C.t2, cursor:'pointer', flexShrink:'0'}} {...hoverStyle({width:'22px', height:'22px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'none', borderRadius:'6px', color:C.t2, cursor:'pointer', flexShrink:'0'}, {color:C.t0})}>{privacyMode ? (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3l18 18" /><path d="M10.6 5.2A9.9 9.9 0 0 1 12 5c6.5 0 10 7 10 7a15.8 15.8 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.6 9.6 0 0 0 4.4-1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>) : (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>)}</button></div><div style={netWorthStyle}>{totalNetWorthText}</div><div style={{fontSize:'11.5px', color:C.t2, marginTop:'2px'}}>{accountsCountText}</div></div><button onClick={onToggleTheme} style={{width:'100%', marginTop:'10px', padding:'8px', background:'transparent', border:'1px solid '+C.b2, borderRadius:'9px', color:C.t2, fontSize:'12px', fontWeight:'500', cursor:'pointer'}} {...hoverStyle({width:'100%', marginTop:'10px', padding:'8px', background:'transparent', border:'1px solid '+C.b2, borderRadius:'9px', color:C.t2, fontSize:'12px', fontWeight:'500', cursor:'pointer'}, {borderColor:C.b4, color:C.t0})}>{isLight ? 'Tema scuro' : 'Tema chiaro'}</button><button onClick={onLogout} style={{width:'100%', marginTop:'8px', padding:'8px', background:'transparent', border:'1px solid '+C.b2, borderRadius:'9px', color:C.t2, fontSize:'12px', fontWeight:'500', cursor:'pointer'}} {...hoverStyle({width:'100%', marginTop:'8px', padding:'8px', background:'transparent', border:'1px solid '+C.b2, borderRadius:'9px', color:C.t2, fontSize:'12px', fontWeight:'500', cursor:'pointer'}, {borderColor:C.b4, color:C.t0})}>Esci</button></div></aside></React.Fragment>) : null}<main style={{flex:'1', minWidth:'0', display:'flex', flexDirection:'column', height:'100vh', overflowY:'auto'}}><header style={{display:'flex', alignItems:'center', gap:'10px', padding:'10px 16px', borderBottom:'1px solid '+C.b1, flexShrink:'0'}}><div style={{position:'relative', flexShrink:'0'}}><button onClick={onMenu} title={menuTitle} style={{width:'30px', height:'30px', flexShrink:'0', display:'flex', alignItems:'center', justifyContent:'center', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'8px', color:C.t0, cursor:'pointer'}} {...hoverStyle({width:'30px', height:'30px', flexShrink:'0', display:'flex', alignItems:'center', justifyContent:'center', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'8px', color:C.t0, cursor:'pointer'}, {borderColor:C.b4})}>{isMobile ? (<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="12" cy="19" r="1.8" /></svg>) : (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="20" y2="17" /></svg>)}</button>{(mobileMoreOpen) ? (<React.Fragment><div onClick={closeMobileMore} style={{position:'fixed', inset:'0', zIndex:'55'}}></div><div style={{position:'absolute', top:'36px', left:'0', zIndex:'56', background:C.bg2, border:'1px solid '+C.b2, borderRadius:'10px', boxShadow:'0 8px 24px rgba(0,0,0,0.3)', overflow:'hidden', minWidth:'160px'}}><button onClick={onToggleThemeMobile} style={{display:'block', width:'100%', textAlign:'left', padding:'11px 14px', background:'none', border:'none', borderBottom:'1px solid '+C.b1, color:C.t0, fontSize:'13px', fontWeight:'500', cursor:'pointer'}}>{isLight ? 'Tema scuro' : 'Tema chiaro'}</button><button onClick={onLogoutMobile} style={{display:'block', width:'100%', textAlign:'left', padding:'11px 14px', background:'none', border:'none', color:'#f0616d', fontSize:'13px', fontWeight:'500', cursor:'pointer'}}>Esci</button></div></React.Fragment>) : null}</div><button onClick={onTogglePrivacy} title={privacyMode ? 'Mostra importi' : 'Nascondi importi (privacy)'} style={{width:'30px', height:'30px', flexShrink:'0', display:'flex', alignItems:'center', justifyContent:'center', background: privacyMode?'#5b8def':C.bg1, border:'1px solid '+(privacyMode?'#5b8def':C.b2), borderRadius:'8px', color: privacyMode?'#fff':C.t0, cursor:'pointer'}} {...hoverStyle({width:'30px', height:'30px', flexShrink:'0', display:'flex', alignItems:'center', justifyContent:'center', background: privacyMode?'#5b8def':C.bg1, border:'1px solid '+(privacyMode?'#5b8def':C.b2), borderRadius:'8px', color: privacyMode?'#fff':C.t0, cursor:'pointer'}, {borderColor:C.b4})}>{privacyMode ? (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3l18 18" /><path d="M10.6 5.2A9.9 9.9 0 0 1 12 5c6.5 0 10 7 10 7a15.8 15.8 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.6 9.6 0 0 0 4.4-1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>) : (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>)}</button><div style={{flex:'1', minWidth:'0'}}><h1 style={{margin:'0', fontSize:'15px', fontWeight:'700', letterSpacing:'-0.2px'}}>{navTitle}</h1><p style={{margin:'0', fontSize:'11px', color:C.t2}}>{navSubtitle}</p></div><button onClick={onPrimary} style={{display:'inline-flex', alignItems:'center', gap:'6px', padding:'6px 12px', background:'#5b8def', border:'none', borderRadius:'8px', color:'#fff', fontSize:'12px', fontWeight:'600', cursor:'pointer', boxShadow:'0 1px 8px rgba(91,141,239,0.3)', whiteSpace:'nowrap'}} {...hoverStyle({display:'inline-flex', alignItems:'center', gap:'6px', padding:'6px 12px', background:'#5b8def', border:'none', borderRadius:'8px', color:'#fff', fontSize:'12px', fontWeight:'600', cursor:'pointer', boxShadow:'0 1px 8px rgba(91,141,239,0.3)', whiteSpace:'nowrap'}, {background:'#6f9bf2'})}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg><span>{primaryLabel}</span></button></header><div style={{flex:'1', padding: isMobile ? '14px' : '28px', paddingBottom: isMobile ? '78px' : '28px'}}>{/* ============ DASHBOARD ============ */}{(isDashboard) ? (<React.Fragment><div style={{maxWidth:'1080px', margin:'0 auto'}}>{(isMobile) ? (<React.Fragment><div style={{display:'flex', gap:'8px', overflowX:'auto', paddingBottom:'12px', marginBottom:'8px'}}>{(dashChips || []).map((d, dIdx) => (<React.Fragment key={dIdx}><button onClick={d.onClick} style={d.style}>{d.label}</button></React.Fragment>))}</div></React.Fragment>) : null}<div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'14px', flexWrap:'wrap', marginBottom:'20px'}}><div style={{display:'flex', alignItems:'center', gap:'10px', flexWrap:'wrap'}}><select value={dashAccountId} onChange={onDashAccount} style={{padding:'8px 11px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, fontSize:'13px', fontWeight:'500'}}><option value="">Tutti i conti</option>{(dashAccountOptions || []).map((opt, optIdx) => (<React.Fragment key={optIdx}><option value={opt.value}>{opt.label}</option></React.Fragment>))}</select><div style={{display:'flex', gap:'2px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', padding:'3px'}}>{(dashRangeBtns || []).map((b, bIdx) => (<React.Fragment key={bIdx}><button onClick={b.onClick} style={b.style}>{b.label}</button></React.Fragment>))}</div>{(dashCustomOpen) ? (<React.Fragment><div style={{display:'flex', alignItems:'center', gap:'6px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', padding:'6px 9px'}}><input type="date" value={dashCustomFrom} onChange={onDashCustomFrom} style={{background:C.bg0, border:'1px solid '+C.b2, borderRadius:'7px', color:C.t0, fontSize:'12px', padding:'5px 7px'}} /><span style={{color:C.t3, fontSize:'12px'}}>–</span><input type="date" value={dashCustomTo} onChange={onDashCustomTo} style={{background:C.bg0, border:'1px solid '+C.b2, borderRadius:'7px', color:C.t0, fontSize:'12px', padding:'5px 7px'}} /></div></React.Fragment>) : null}</div><div style={{fontSize:'12.5px', color:C.t2, fontWeight:'500'}}>Periodo: <b style={{color:C.t1}}>{dashPeriodLabel}</b></div></div>{/* KPI: sempre visibili, coerenti con il filtro sopra */}<div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))', gap:'14px', marginBottom:'24px'}}>{(kpis || []).map((k, kIdx) => (<React.Fragment key={kIdx}><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', padding:'16px 18px'}}><div style={{fontSize:'11px', color:C.t2, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.4px'}}>{k.label}</div><div style={k.valStyle}>{k.value}</div><div style={{fontSize:'11.5px', color:C.t3, marginTop:'3px'}}>{k.sub}</div></div></React.Fragment>))}</div>{/* Scheda: Patrimonio netto */}{(isDashNetWorth) ? (<React.Fragment><div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(360px,1fr))', gap:'16px'}}><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', padding:'20px'}}><div style={{display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:'14px', flexWrap:'wrap'}}><div><div style={{fontSize:'11px', color:C.t2, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.4px'}}>Patrimonio netto</div><div style={{fontFamily:'\'JetBrains Mono\',monospace', fontWeight:'700', fontSize:'24px', marginTop:'4px'}}>{nwTrend.currentText}</div></div><div style={{textAlign:'right'}}><div style={{fontSize:'11px', color:C.t2, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.4px'}}>Variazione</div><div style={nwTrend.changeStyle}>{nwTrend.changeText}</div></div></div><div style={{position:'relative', width:'100%', height:'200px', marginTop:'14px'}}><svg viewBox="0 0 100 60" preserveAspectRatio="none" style={{width:'100%', height:'100%', display:'block'}}><path d={nwTrend.areaPath} fill="rgba(91,141,239,0.14)" /><path d={nwTrend.linePath} fill="none" stroke="#5b8def" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" /></svg>{(nwTrend.dots || []).map((d, dIdx) => (<React.Fragment key={dIdx}><div style={d.style} title={d.title}></div></React.Fragment>))}</div><div style={{display:'flex', justifyContent:'space-between', fontSize:'10.5px', color:C.t3, marginTop:'8px'}}><span>{nwTrend.startLabel}</span><span>{nwTrend.endLabel}</span></div><p style={{margin:'16px 0 0', fontSize:'12px', color:C.t3}}>Somma dei saldi di tutti i conti (attività) al netto degli eventuali saldi negativi (passività), mese per mese.</p></div><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', padding:'20px'}}><h3 style={{margin:'0 0 14px', fontSize:'14px', fontWeight:'700'}}>Composizione attuale</h3>{(!allocHasData) ? (<React.Fragment><div style={{padding:'36px', textAlign:'center', color:C.t2}}>Nessun saldo positivo da mostrare.</div></React.Fragment>) : null}<div style={{display:'flex', alignItems:'center', gap:'20px', flexWrap:'wrap'}}><div style={{position:'relative', width:'132px', height:'132px', flexShrink:'0'}}><svg viewBox="0 0 42 42" style={{width:'132px', height:'132px', transform:'rotate(-90deg)'}}><circle cx="21" cy="21" r="15.915" fill="none" stroke={C.b0} strokeWidth="5" />{(allocSegs || []).map((s, sIdx) => (<React.Fragment key={sIdx}><circle cx="21" cy="21" r="15.915" fill="none" stroke={s.color} strokeWidth="5" strokeDasharray={s.dash} strokeDashoffset={s.offset} /></React.Fragment>))}</svg><div style={{position:'absolute', inset:'0', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', textAlign:'center'}}><div style={{fontSize:'9.5px', color:C.t2, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.4px'}}>Totale</div><div style={{fontFamily:'\'JetBrains Mono\',monospace', fontWeight:'600', fontSize:'13px'}}>{allocTotalText}</div></div></div><div style={{flex:'1', minWidth:'150px', display:'flex', flexDirection:'column', gap:'9px'}}>{(allocSegs || []).map((s, sIdx) => (<React.Fragment key={sIdx}><div style={{display:'flex', alignItems:'center', gap:'9px'}}><span style={s.dotStyle}></span><span style={{flex:'1', fontSize:'12.5px', color:C.t6, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{s.label}</span><span style={{fontFamily:'\'JetBrains Mono\',monospace', fontSize:'12px', color:C.t1}}>{s.valueText}</span><span style={{fontSize:'11px', color:C.t3, width:'34px', textAlign:'right'}}>{s.pctText}</span></div></React.Fragment>))}</div></div></div><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', padding:'20px'}}><h3 style={{margin:'0 0 14px', fontSize:'14px', fontWeight:'700'}}>Composizione per conto</h3>{(!allocAccHasData) ? (<React.Fragment><div style={{padding:'36px', textAlign:'center', color:C.t2}}>Nessun saldo positivo da mostrare.</div></React.Fragment>) : null}<div style={{display:'flex', alignItems:'center', gap:'20px', flexWrap:'wrap'}}><div style={{position:'relative', width:'132px', height:'132px', flexShrink:'0'}}><svg viewBox="0 0 42 42" style={{width:'132px', height:'132px', transform:'rotate(-90deg)'}}><circle cx="21" cy="21" r="15.915" fill="none" stroke={C.b0} strokeWidth="5" />{(allocAccSegs || []).map((s, sIdx) => (<React.Fragment key={sIdx}><circle cx="21" cy="21" r="15.915" fill="none" stroke={s.color} strokeWidth="5" strokeDasharray={s.dash} strokeDashoffset={s.offset} /></React.Fragment>))}</svg><div style={{position:'absolute', inset:'0', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', textAlign:'center'}}><div style={{fontSize:'9.5px', color:C.t2, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.4px'}}>Totale</div><div style={{fontFamily:'\'JetBrains Mono\',monospace', fontWeight:'600', fontSize:'13px'}}>{allocAccTotalText}</div></div></div><div style={{flex:'1', minWidth:'150px', display:'flex', flexDirection:'column', gap:'9px'}}>{(allocAccSegs || []).map((s, sIdx) => (<React.Fragment key={sIdx}><div style={{display:'flex', alignItems:'center', gap:'9px'}}><span style={s.dotStyle}></span><span style={{flex:'1', fontSize:'12.5px', color:C.t6, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{s.label}</span><span style={{fontFamily:'\'JetBrains Mono\',monospace', fontSize:'12px', color:C.t1}}>{s.valueText}</span><span style={{fontSize:'11px', color:C.t3, width:'34px', textAlign:'right'}}>{s.pctText}</span></div></React.Fragment>))}</div></div></div></div></React.Fragment>) : null}{/* Scheda: Spese */}{(isDashSpending) ? (<React.Fragment><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', padding:'20px'}}><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'14px', flexWrap:'wrap', marginBottom:'6px'}}><h3 style={{margin:'0', fontSize:'14px', fontWeight:'700'}}>Spese per categoria</h3><div style={{display:'flex', alignItems:'center', gap:'8px', flexWrap:'wrap'}}><select value={dashGroupId} onChange={onDashGroup} style={{padding:'6px 9px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'8px', color:C.t0, fontSize:'12px', fontWeight:'500'}}><option value="">Tutti i gruppi</option>{(dashGroupOptions || []).map((opt, optIdx) => (<React.Fragment key={optIdx}><option value={opt.value}>{opt.label}</option></React.Fragment>))}</select><select value={dashCategoryId} onChange={onDashCategory} style={{padding:'6px 9px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'8px', color:C.t0, fontSize:'12px', fontWeight:'500'}}><option value="">Tutte le categorie</option>{(dashCategoryOptions || []).map((opt, optIdx) => (<React.Fragment key={optIdx}><option value={opt.value}>{opt.label}</option></React.Fragment>))}</select>{(dashFilterActive) ? (<React.Fragment><button onClick={clearDashFilter} style={{display:'inline-flex', alignItems:'center', gap:'6px', padding:'6px 10px', background:'rgba(91,141,239,0.12)', border:'1px solid rgba(91,141,239,0.35)', borderRadius:'8px', color:C.chipBlue, fontSize:'11.5px', fontWeight:'600', cursor:'pointer'}} {...hoverStyle({display:'inline-flex', alignItems:'center', gap:'6px', padding:'6px 10px', background:'rgba(91,141,239,0.12)', border:'1px solid rgba(91,141,239,0.35)', borderRadius:'8px', color:C.chipBlue, fontSize:'11.5px', fontWeight:'600', cursor:'pointer'}, {background:'rgba(91,141,239,0.2)'})}>{dashFilterLabel} ×</button></React.Fragment>) : null}</div></div><div style={{marginBottom:'20px'}}><div style={{fontSize:'11px', color:C.t2, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.4px'}}>Totale speso</div><div style={{fontFamily:'\'JetBrains Mono\',monospace', fontWeight:'700', fontSize:'28px', marginTop:'4px'}}>{spendTotalText}</div></div>{(spendEmpty) ? (<React.Fragment><div style={{padding:'40px', textAlign:'center', color:C.t2}}>Nessuna spesa nel periodo selezionato.</div></React.Fragment>) : null}<div style={{display:'flex', alignItems:'flex-start', gap:'26px', flexWrap:'wrap'}}><div style={{position:'relative', width:'150px', height:'150px', flexShrink:'0'}}><svg viewBox="0 0 42 42" style={{width:'150px', height:'150px', transform:'rotate(-90deg)'}}><circle cx="21" cy="21" r="15.915" fill="none" stroke={C.b0} strokeWidth="5" />{(spendSegs || []).map((s, sIdx) => (<React.Fragment key={sIdx}><circle cx="21" cy="21" r="15.915" fill="none" stroke={s.color} strokeWidth="5" strokeDasharray={s.dash} strokeDashoffset={s.offset} /></React.Fragment>))}</svg></div><div style={{flex:'1', minWidth:'230px', display:'flex', flexDirection:'column', gap:'2px'}}>{(spendCats || []).map((c, cIdx) => (<React.Fragment key={cIdx}><div onClick={c.onClick} style={{display:'grid', gridTemplateColumns:'16px 1fr 90px 44px', gap:'10px', alignItems:'center', padding:'9px 0', cursor:'pointer', borderBottom:'1px solid '+C.b0}} {...hoverStyle({display:'grid', gridTemplateColumns:'16px 1fr 90px 44px', gap:'10px', alignItems:'center', padding:'9px 0', cursor:'pointer', borderBottom:'1px solid '+C.b0}, {opacity:'0.82'})}><span style={c.dotStyle}></span><div style={{minWidth:'0'}}><div style={{fontSize:'13px', fontWeight:'600', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{c.name}</div><div style={{height:'4px', marginTop:'5px', background:C.b1, borderRadius:'3px', overflow:'hidden'}}><div style={c.barStyle}></div></div></div><span style={{textAlign:'right', fontFamily:'\'JetBrains Mono\',monospace', fontSize:'12.5px'}}>{c.amountText}</span><span style={{textAlign:'right', fontSize:'11px', color:C.t3}}>{c.pctText}</span></div></React.Fragment>))}</div></div></div></React.Fragment>) : null}{/* Scheda: Entrate vs Uscite */}{(isDashIncomeExpense) ? (<React.Fragment><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', padding:'20px'}}><div style={{display:'flex', alignItems:'center', gap:'14px', fontSize:'11.5px', color:C.t1, marginBottom:'14px'}}><span style={{display:'inline-flex', alignItems:'center', gap:'5px'}}><span style={{width:'9px', height:'9px', borderRadius:'2px', background:'#3ecf8e'}}></span>Entrate</span><span style={{display:'inline-flex', alignItems:'center', gap:'5px'}}><span style={{width:'9px', height:'9px', borderRadius:'2px', background:'#f0616d'}}></span>Uscite</span></div><div style={{display:'flex', alignItems:'flex-end', gap:'8px', overflowX:'auto', paddingBottom:'4px'}}>{(ieBars || []).map((b, bIdx) => (<React.Fragment key={bIdx}><div onClick={b.onClick} title={b.title} style={{flex:'1', minWidth:'40px', display:'flex', flexDirection:'column', alignItems:'center', gap:'7px', cursor:'pointer'}} {...hoverStyle({flex:'1', minWidth:'40px', display:'flex', flexDirection:'column', alignItems:'center', gap:'7px', cursor:'pointer'}, {opacity:'0.82'})}><div style={{width:'100%', height:'180px', display:'flex', alignItems:'flex-end', justifyContent:'center', gap:'3px'}}><div style={b.incomeStyle}></div><div style={b.expenseStyle}></div></div><div style={{fontSize:'10.5px', color:C.t2, whiteSpace:'nowrap'}}>{b.label}</div><div style={b.netStyle}>{b.netText}</div></div></React.Fragment>))}</div><div style={{fontSize:'11px', color:C.t3, marginTop:'12px'}}>Clicca un mese per aprire i movimenti corrispondenti · il numero sotto ogni colonna è il risparmio netto del mese</div>{(ieInsight) ? (<React.Fragment><div style={{marginTop:'16px', paddingTop:'16px', borderTop:'1px solid '+C.b1, display:'flex', alignItems:'center', gap:'10px'}}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#8b7cf6" strokeWidth="1.8" style={{flexShrink:'0'}}><circle cx="12" cy="12" r="9" /><path d="M12 8v5" strokeLinecap="round" /><circle cx="12" cy="16" r="0.6" fill="#8b7cf6" /></svg><span style={{fontSize:'13px', fontWeight:'600', color:C.t6}}>{ieInsight}</span></div></React.Fragment>) : null}</div></React.Fragment>) : null}{/* Scheda: Obiettivi */}{(isDashGoals) ? (<React.Fragment><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', padding:'20px'}}><div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:'6px', flexWrap:'wrap', gap:'8px'}}><h3 style={{margin:'0', fontSize:'14px', fontWeight:'700'}}>Obiettivi</h3><span style={{fontSize:'12.5px', color:C.t1}}>{goalsFundedCount} di {goalsTotalCount} finanziati</span></div><div style={{fontSize:'11px', color:C.t3, marginBottom:'16px'}}>Riferito al mese corrente, indipendente dal filtro periodo qui sopra.</div>{(goalsEmpty) ? (<React.Fragment><div style={{padding:'40px', textAlign:'center', color:C.t2}}>Nessuna categoria con un obiettivo impostato.</div></React.Fragment>) : (<React.Fragment><div style={{marginBottom:'18px'}}><div style={{fontSize:'11px', color:C.t2, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.4px'}}>Mancano in totale</div><div style={{fontFamily:'\'JetBrains Mono\',monospace', fontWeight:'700', fontSize:'22px', marginTop:'4px'}}>{goalsTotalToGoText}</div></div><div style={{display:'flex', flexDirection:'column', gap:'2px'}}>{(goalRows || []).map((r, ri) => (<React.Fragment key={ri}><div onClick={r.onClick} style={{padding:'12px 0', borderBottom:'1px solid '+C.b0, cursor:'pointer'}} {...hoverStyle({padding:'12px 0', borderBottom:'1px solid '+C.b0, cursor:'pointer'}, {opacity:'0.82'})}><div style={{display:'flex', justifyContent:'space-between', alignItems:'center', gap:'10px'}}><div style={{minWidth:'0'}}><div style={{fontSize:'13px', fontWeight:'600', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{r.name}</div><div style={{fontSize:'11px', color:C.t3, marginTop:'1px'}}>{r.cadenceText}</div></div><div style={{textAlign:'right', flexShrink:'0'}}><div style={{fontFamily:'\'JetBrains Mono\',monospace', fontSize:'12.5px', fontWeight:'600', color: r.funded?'#3ecf8e':C.t0}}>{r.assignedText} / {r.neededText}</div>{(!r.funded) ? (<React.Fragment><div style={{fontSize:'10.5px', color:'#e2b341'}}>mancano {r.toGoText}</div></React.Fragment>) : (<React.Fragment><div style={{fontSize:'10.5px', color:'#3ecf8e'}}>finanziato</div></React.Fragment>)}</div></div><div style={{height:'4px', marginTop:'7px', background:C.b1, borderRadius:'3px', overflow:'hidden'}}><div style={r.barStyle}></div></div></div></React.Fragment>))}</div></React.Fragment>)}</div></React.Fragment>) : null}{/* Scheda: Categorie in affanno */}{(isDashStruggling) ? (<React.Fragment><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', padding:'20px'}}><h3 style={{margin:'0 0 6px', fontSize:'14px', fontWeight:'700'}}>Categorie in affanno</h3><div style={{fontSize:'11px', color:C.t3, marginBottom:'16px'}}>Quante volte, nel periodo selezionato, ogni categoria è finita in negativo a fine mese.</div>{(struggleEmpty) ? (<React.Fragment><div style={{padding:'40px', textAlign:'center', color:C.t2}}>Nessuna categoria è mai andata in negativo, nel periodo selezionato.</div></React.Fragment>) : (<React.Fragment><div style={{display:'flex', flexDirection:'column', gap:'2px'}}>{(struggleRowsFinal || []).map((r, ri) => (<React.Fragment key={ri}><div onClick={r.onClick} style={{padding:'11px 0', borderBottom:'1px solid '+C.b0, cursor:'pointer'}} {...hoverStyle({padding:'11px 0', borderBottom:'1px solid '+C.b0, cursor:'pointer'}, {opacity:'0.82'})}><div style={{display:'flex', justifyContent:'space-between', alignItems:'center', gap:'10px'}}><div style={{fontSize:'13px', fontWeight:'600'}}>{r.name}</div><div style={{textAlign:'right', flexShrink:'0'}}><div style={{fontSize:'12px', fontWeight:'600', color:'#f0616d'}}>{r.freqText}</div><div style={{fontSize:'10.5px', color:C.t3}}>media {r.avgOverText}</div></div></div><div style={{height:'4px', marginTop:'7px', background:C.b1, borderRadius:'3px', overflow:'hidden'}}><div style={r.barStyle}></div></div></div></React.Fragment>))}</div></React.Fragment>)}</div></React.Fragment>) : null}{/* Scheda: Spese fisse vs variabili */}{(isDashFixedVar) ? (<React.Fragment><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', padding:'20px'}}><h3 style={{margin:'0 0 6px', fontSize:'14px', fontWeight:'700'}}>Spese fisse vs variabili</h3>{(!anyGroupTaggedFixed) ? (<React.Fragment><div style={{fontSize:'11.5px', color:'#e2b341', marginBottom:'14px', lineHeight:'1.5'}}>Non hai ancora marcato nessun gruppo come "di spese fisse". Vai su Categorie → modifica un gruppo (es. "Obblighi fissi") e attiva l'interruttore, poi torna qui.</div></React.Fragment>) : null}{(fvEmpty) ? (<React.Fragment><div style={{padding:'40px', textAlign:'center', color:C.t2}}>Nessuna spesa nel periodo selezionato.</div></React.Fragment>) : (<React.Fragment><div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))', gap:'14px', marginBottom:'20px'}}><div><div style={{fontSize:'11px', color:C.t2, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.4px'}}>Spese fisse</div><div style={{fontFamily:'\'JetBrains Mono\',monospace', fontWeight:'700', fontSize:'20px', marginTop:'4px', color:'#5b8def'}}>{fvTotalFixedText}</div></div><div><div style={{fontSize:'11px', color:C.t2, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.4px'}}>Spese variabili</div><div style={{fontFamily:'\'JetBrains Mono\',monospace', fontWeight:'700', fontSize:'20px', marginTop:'4px', color:'#e2b341'}}>{fvTotalVarText}</div></div><div><div style={{fontSize:'11px', color:C.t2, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.4px'}}>Quota fissa</div><div style={{fontFamily:'\'JetBrains Mono\',monospace', fontWeight:'700', fontSize:'20px', marginTop:'4px'}}>{fvPctFixed}%</div></div></div><div style={{display:'flex', alignItems:'center', gap:'14px', fontSize:'11.5px', color:C.t1, marginBottom:'14px'}}><span style={{display:'inline-flex', alignItems:'center', gap:'5px'}}><span style={{width:'9px', height:'9px', borderRadius:'2px', background:'#5b8def'}}></span>Fisse</span><span style={{display:'inline-flex', alignItems:'center', gap:'5px'}}><span style={{width:'9px', height:'9px', borderRadius:'2px', background:'#e2b341'}}></span>Variabili</span></div><div style={{display:'flex', alignItems:'flex-end', gap:'8px', overflowX:'auto', paddingBottom:'4px'}}>{(fvBars || []).map((b, bi) => (<React.Fragment key={bi}><div onClick={b.onClick} title={b.title} style={{flex:'1', minWidth:'40px', display:'flex', flexDirection:'column', alignItems:'center', gap:'7px', cursor:'pointer'}} {...hoverStyle({flex:'1', minWidth:'40px', display:'flex', flexDirection:'column', alignItems:'center', gap:'7px', cursor:'pointer'}, {opacity:'0.82'})}><div style={{width:'100%', height:'180px', display:'flex', alignItems:'flex-end', justifyContent:'center', gap:'3px'}}><div style={b.fixedStyle}></div><div style={b.varStyle}></div></div><div style={{fontSize:'10.5px', color:C.t2, whiteSpace:'nowrap'}}>{b.label}</div></div></React.Fragment>))}</div><div style={{fontSize:'11px', color:C.t3, marginTop:'12px'}}>Clicca un mese per aprire i movimenti corrispondenti.</div></React.Fragment>)}</div></React.Fragment>) : null}{/* Scheda: Risparmio & Età del denaro */}{(isDashSavings) ? (<React.Fragment><div style={{display:'flex', flexDirection:'column', gap:'16px'}}><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', padding:'20px'}}><div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(170px,1fr))', gap:'14px'}}>{(savSummary || []).map((k, kIdx) => (<React.Fragment key={kIdx}><div><div style={{fontSize:'11px', color:C.t2, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.4px'}}>{k.label}</div><div style={k.valStyle}>{k.value}</div></div></React.Fragment>))}</div></div><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', padding:'20px'}}><h3 style={{margin:'0 0 14px', fontSize:'14px', fontWeight:'700'}}>Tasso di risparmio mensile</h3>{(savEmpty) ? (<React.Fragment><div style={{padding:'40px', textAlign:'center', color:C.t2}}>Nessun dato nel periodo selezionato.</div></React.Fragment>) : null}<div style={{display:'flex', flexDirection:'column', gap:'2px'}}>{(savRows || []).map((r, rIdx) => (<React.Fragment key={rIdx}><div onClick={r.onClick} style={{display:'grid', gridTemplateColumns:'48px 1fr 54px 92px', gap:'12px', alignItems:'center', padding:'8px 0', cursor:'pointer', borderBottom:'1px solid '+C.b0}} {...hoverStyle({display:'grid', gridTemplateColumns:'48px 1fr 54px 92px', gap:'12px', alignItems:'center', padding:'8px 0', cursor:'pointer', borderBottom:'1px solid '+C.b0}, {opacity:'0.82'})}><span style={{fontSize:'11.5px', color:C.t1}}>{r.label}</span><div style={{height:'8px', background:C.b0, borderRadius:'4px', overflow:'hidden'}}><div style={r.barStyle}></div></div><span style={r.rateStyle}>{r.rateText}</span><span style={{textAlign:'right', fontFamily:'\'JetBrains Mono\',monospace', fontSize:'12px', color:C.t1}}>{r.netText}</span></div></React.Fragment>))}</div><p style={{margin:'14px 0 0', fontSize:'11px', color:C.t3}}>Tasso di risparmio = (entrate − uscite) / entrate del mese. Clicca una riga per aprire i movimenti di quel mese.</p></div></div></React.Fragment>) : null}</div></React.Fragment>) : null}{/* ============ BUDGET ============ */}{(isBudget) ? (<React.Fragment><div style={{maxWidth:'940px', margin:'0 auto'}}><div style={{position:'sticky', top:'0', zIndex:'6', background:C.bg0, paddingTop:'2px', paddingBottom:'14px', marginBottom:'6px'}} ref={this.budgetStickyRef}><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'16px', flexWrap:'wrap'}}><div style={{display:'flex', alignItems:'center', gap:'6px'}}><button onClick={onPrevMonth} style={{width:'34px', height:'34px', display:'flex', alignItems:'center', justifyContent:'center', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, cursor:'pointer'}} {...hoverStyle({width:'34px', height:'34px', display:'flex', alignItems:'center', justifyContent:'center', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, cursor:'pointer'}, {borderColor:C.b4})}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="15 18 9 12 15 6" /></svg></button><div style={{minWidth:'150px', textAlign:'center', fontWeight:'600', fontSize:'15px'}}>{monthLabel}</div><button onClick={onNextMonth} style={{width:'34px', height:'34px', display:'flex', alignItems:'center', justifyContent:'center', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, cursor:'pointer'}} {...hoverStyle({width:'34px', height:'34px', display:'flex', alignItems:'center', justifyContent:'center', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, cursor:'pointer'}, {borderColor:C.b4})}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="9 18 15 12 9 6" /></svg></button></div><div style={readyCardStyle}><div style={{display:'flex', alignItems:'center', justifyContent:'flex-end', gap:'6px'}}>{(readyWarning) ? (<React.Fragment><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L14.71 3.86a2 2 0 0 0-3.42 0Z" /></svg></React.Fragment>) : null}{(readyZero) ? (<React.Fragment><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M8.5 12.5l2.2 2.2 5-5" /></svg></React.Fragment>) : null}<div style={{fontSize:'11px', fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.5px', opacity:'0.85'}}>{readyLabel}</div></div><div style={{fontFamily:'\'JetBrains Mono\',monospace', fontWeight:'600', fontSize:'20px', marginTop:'1px'}}>{readyText}</div>{(readyWarning) ? (<React.Fragment><div style={{fontSize:'11px', marginTop:'5px', color:C.chipRed, lineHeight:'1.4'}}>{readySubtext}</div></React.Fragment>) : null}</div></div></div><div style={{display:'flex', justifyContent:'flex-end', marginBottom:'10px'}}><button onClick={onResetBudgets} title="Azzera l'assegnato in tutte le categorie, in tutti i mesi. Conti, movimenti e categorie non vengono toccati." style={{background:'none', border:'none', color:C.t2, fontSize:'11.5px', fontWeight:'600', cursor:'pointer', padding:'0'}} {...hoverStyle({background:'none', border:'none', color:C.t2, fontSize:'11.5px', fontWeight:'600', cursor:'pointer', padding:'0'}, {color:'#f0616d'})}>Azzera tutte le assegnazioni</button></div><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', overflow:'hidden'}}><div style={{display:'grid', gridTemplateColumns:'minmax(0,1fr) minmax(48px,58px) minmax(64px,84px)', gap:'8px', alignItems:'center', height:'38px', padding:'0 18px', background:C.bg2, borderBottom:'1px solid '+C.b1, fontSize:'11px', color:C.t2, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.4px'}}><div style={{overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>Categoria</div><div style={{textAlign:'right', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{isMobile ? 'Ass.' : 'Assegnato'}</div><div style={{textAlign:'right', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{isMobile ? 'Disp.' : 'Disponibile'}</div></div>{(budgetGroups || []).map((grp, grpIdx) => (<React.Fragment key={grpIdx}><div style={{display:'grid', gridTemplateColumns:'minmax(0,1fr) minmax(48px,58px) minmax(64px,84px)', gap:'8px', alignItems:'center', padding:'11px 18px', background:C.bg1, borderBottom:'1px solid '+C.b1}}><div onClick={grp.onToggleCollapse} style={{display:'flex', alignItems:'center', gap:'6px', cursor:'pointer', fontSize:'11px', fontWeight:'700', textTransform:'uppercase', letterSpacing:'0.5px', color:C.t4}}><svg style={grp.chevronStyle} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg><span>{grp.name}</span></div><div style={{textAlign:'right', fontFamily:'\'JetBrains Mono\',monospace', fontSize:'11.5px', color:C.t2}}>{grp.assignedText}</div><div style={{textAlign:'right'}}><span style={grp.availStyle}>{grp.availText}</span></div></div>{(grp.collapsed ? [] : (grp.rows || [])).map((row, rowIdx) => (<React.Fragment key={rowIdx}><div style={Object.assign({display:'grid', gridTemplateColumns:'minmax(0,1fr) minmax(48px,58px) minmax(64px,84px)', gap:'8px', alignItems:'center', padding:'13px 18px', borderBottom:'1px solid '+C.b0}, row.rowStyle)}><div style={{minWidth:'0'}}><div style={{display:'flex', alignItems:'center', gap:'6px'}}><div onClick={row.onOpenDetail} style={{fontWeight:'600', fontSize:'13.5px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', cursor:'pointer'}}>{row.name}</div><button onClick={row.onMove} title="Sposta fondi verso un'altra categoria" style={{width:'19px', height:'19px', flexShrink:'0', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:'#5b8def', cursor:'pointer', padding:'0'}} {...hoverStyle({width:'19px', height:'19px', flexShrink:'0', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:'#5b8def', cursor:'pointer', padding:'0'}, {background:'rgba(91,141,239,0.16)'})}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 7h11M14 3l4 4-4 4" /><path d="M17 17H6M10 21l-4-4 4-4" /></svg></button></div>{(row.hasHint) ? (<React.Fragment><div style={row.hintStyle}>{row.hint}</div></React.Fragment>) : null}<div style={{height:'5px', marginTop:'7px', background:C.b1, borderRadius:'4px', overflow:'hidden'}}><div style={row.barStyle}></div></div></div><div style={{display:'flex', justifyContent:'flex-end'}}>{isMobile ? (<button onClick={row.onOpenKeypad} style={{width:'100%', minWidth:'0', textAlign:'right', padding:'7px 6px', background: row.kpActive?'#5b8def':C.bg0, border:'1px solid '+(row.kpActive?'#5b8def':C.b2), borderRadius:'8px', color: row.kpActive?'#fff':C.t0, fontFamily:'\'JetBrains Mono\',monospace', fontSize:'13px', cursor:'pointer'}}>{row.assignedDisplayText}</button>) : (<input type="text" inputMode="decimal" placeholder="0,00" value={row.assignedValue} onChange={row.onAssign} onBlur={row.onAssignBlur} style={{width:'100%', minWidth:'0', textAlign:'right', padding:'7px 6px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'8px', color:C.t0, fontFamily:'\'JetBrains Mono\',monospace', fontSize:'13px'}} />)}</div><div style={{textAlign:'right'}}><span style={row.availPillStyle}>{(row.showFundedCheck) ? (<React.Fragment><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg></React.Fragment>) : null}<span>{row.availText}</span></span></div></div></React.Fragment>))}</React.Fragment>))}{(budgetEmpty) ? (<React.Fragment><div style={{padding:'44px 18px', textAlign:'center', color:C.t2}}>Nessuna categoria di uscita. Creane una nella sezione Categorie.</div></React.Fragment>) : null}</div><p style={{margin:'14px 2px 0', fontSize:'12px', color:C.t3}}>Lo <b style={{color:C.t4}}>speso</b> è calcolato dai movimenti del mese; il <b style={{color:C.t4}}>disponibile</b> è assegnato − speso.</p></div></React.Fragment>) : null}{(budgetKeypad) ? (<React.Fragment><div style={{position:'fixed', left:'0', right:'0', bottom:'0', zIndex:'70', background:C.bg2, borderTop:'1px solid '+C.b2, borderRadius:'16px 16px 0 0', boxShadow:'0 -8px 30px rgba(0,0,0,0.25)', animation:'fpFade .2s cubic-bezier(.2,.8,.3,1)'}}><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 16px', borderBottom:'1px solid '+C.b1}}><div style={{fontWeight:'700', fontSize:'14px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{budgetKeypadCat ? budgetKeypadCat.name : ''}</div><button onClick={onKpClose} style={{width:'28px', height:'28px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'none', borderRadius:'8px', color:C.t2, cursor:'pointer', fontSize:'18px'}}>×</button></div><div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'8px', padding:'12px 16px'}}><button onClick={onKpAutoAssign} disabled={!budgetKeypadHasTarget} style={{display:'flex', flexDirection:'column', alignItems:'center', gap:'4px', padding:'10px 4px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'10px', color: budgetKeypadHasTarget?C.t0:C.t3, cursor: budgetKeypadHasTarget?'pointer':'default', opacity: budgetKeypadHasTarget?1:0.5, fontSize:'11px', fontWeight:'600'}}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" /></svg>Auto-Assegna</button><button onClick={onKpMoveMoney} style={{display:'flex', flexDirection:'column', alignItems:'center', gap:'4px', padding:'10px 4px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'10px', color:C.t0, cursor:'pointer', fontSize:'11px', fontWeight:'600'}}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>Sposta fondi</button><button onClick={onKpToggleStats} style={{display:'flex', flexDirection:'column', alignItems:'center', gap:'4px', padding:'10px 4px', background: statsPopoverOpen?'#5b8def':C.bg1, border:'1px solid '+(statsPopoverOpen?'#5b8def':C.b2), borderRadius:'10px', color: statsPopoverOpen?'#fff':C.t0, cursor:'pointer', fontSize:'11px', fontWeight:'600'}}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 8v5" /><circle cx="12" cy="16" r="0.6" fill="currentColor" /></svg>Dettagli</button></div>{(statsPopoverOpen && budgetKeypadStats) ? (<React.Fragment><div style={{margin:'0 16px 8px', padding:'10px 12px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'10px', display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px'}}><div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:C.t2}}>Assegnato mese scorso</span><b>{budgetKeypadStats.assignedLastMonthText}</b></div><div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:C.t2}}>Speso mese scorso</span><b>{budgetKeypadStats.spentLastMonthText}</b></div><div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:C.t2}}>Media assegnata</span><b>{budgetKeypadStats.avgAssignedText}</b></div><div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:C.t2}}>Media spesa</span><b>{budgetKeypadStats.avgSpentText}</b></div></div></React.Fragment>) : null}<div style={{padding:'0 16px 8px', textAlign:'right', fontFamily:"'JetBrains Mono',monospace", fontWeight:'700', fontSize:'22px'}}>{kpDisplayText}</div><div style={{display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:'1px', background:C.b1, borderTop:'1px solid '+C.b1}}>
              {['7','8','9','−','4','5','6','+','1','2','3','='].map((k,ki)=>(
                <React.Fragment key={ki}><button onClick={()=>{ if(k==='−') onKpOpMinus(); else if(k==='+') onKpOpPlus(); else if(k==='=') onKpEquals(); else onKpDigit(k); }} style={{padding:'16px 0', background:C.bg2, border:'none', color: (k==='−'||k==='+'||k==='=') ? '#5b8def' : C.t0, fontSize:'20px', fontWeight:'600', cursor:'pointer'}}>{k}</button></React.Fragment>
              ))}
              <button onClick={onKpClear} style={{padding:'16px 0', background:C.bg2, border:'none', color:C.chipRed, fontSize:'16px', fontWeight:'600', cursor:'pointer'}}>✕</button>
              <button onClick={()=>onKpDigit('0')} style={{padding:'16px 0', background:C.bg2, border:'none', color:C.t0, fontSize:'20px', fontWeight:'600', cursor:'pointer'}}>0</button>
              <button onClick={onKpBackspace} style={{padding:'16px 0', background:C.bg2, border:'none', color:C.t1, fontSize:'18px', fontWeight:'600', cursor:'pointer'}}>⌫</button>
              <button onClick={onKpDone} style={{padding:'16px 0', background:'#5b8def', border:'none', color:'#fff', fontSize:'14px', fontWeight:'700', cursor:'pointer'}}>fatto</button>
            </div></div></React.Fragment>) : null}{(categoryDetail) ? (<React.Fragment><div style={{position:'fixed', inset:'0', zIndex:'80', background:C.bg0, overflowY:'auto'}}><div style={{display:'flex', alignItems:'center', gap:'12px', padding:'16px 18px', borderBottom:'1px solid '+C.b1}}><button onClick={categoryDetail.onClose} style={{width:'32px', height:'32px', display:'flex', alignItems:'center', justifyContent:'center', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, cursor:'pointer'}}>×</button><h2 style={{margin:'0', fontSize:'17px', fontWeight:'700', flex:'1'}}>{categoryDetail.name}</h2></div><div style={{maxWidth:'520px', margin:'0 auto', padding:'18px'}}><div style={{fontSize:'11px', color:C.t2, fontWeight:'700', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:'8px'}}>Saldo</div><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', overflow:'hidden', marginBottom:'20px'}}><div style={{display:'flex', justifyContent:'space-between', alignItems:'center', padding:'13px 16px', borderBottom:'1px solid '+C.b0}}><span style={{fontSize:'13px', color:C.t1}}>{categoryDetail.fromPrevLabel}</span><span style={{fontFamily:"'JetBrains Mono',monospace", fontWeight:'600', fontSize:'13.5px'}}>{categoryDetail.fromPrevText}</span></div><div onClick={categoryDetail.onToggleStats} style={{display:'flex', justifyContent:'space-between', alignItems:'center', padding:'13px 16px', borderBottom:'1px solid '+C.b0, cursor:'pointer'}}><span style={{fontSize:'13px', color:C.t1}}>Assegnato per questo mese</span><span style={{display:'flex', alignItems:'center', gap:'6px'}}><span style={{fontFamily:"'JetBrains Mono',monospace", fontWeight:'600', fontSize:'13.5px'}}>{categoryDetail.assignedText}</span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.t3} strokeWidth="2" strokeLinecap="round"><polyline points="9 18 15 12 9 6" /></svg></span></div>{(statsPopoverOpen) ? (<React.Fragment><div style={{padding:'10px 16px', background:C.bg1, borderBottom:'1px solid '+C.b0, display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px'}}><div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:C.t2}}>Assegnato mese scorso</span><b>{categoryDetail.stats.assignedLastMonthText}</b></div><div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:C.t2}}>Speso mese scorso</span><b>{categoryDetail.stats.spentLastMonthText}</b></div><div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:C.t2}}>Media assegnata</span><b>{categoryDetail.stats.avgAssignedText}</b></div><div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:C.t2}}>Media spesa</span><b>{categoryDetail.stats.avgSpentText}</b></div></div></React.Fragment>) : null}<div onClick={categoryDetail.onActivity} style={{display:'flex', justifyContent:'space-between', alignItems:'center', padding:'13px 16px', borderBottom:'1px solid '+C.b0, cursor:'pointer'}}><span style={{fontSize:'13px', color:C.t1}}>Attività in questo mese</span><span style={{display:'flex', alignItems:'center', gap:'6px'}}><span style={{fontFamily:"'JetBrains Mono',monospace", fontWeight:'600', fontSize:'13.5px'}}>{categoryDetail.activityText}</span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.t3} strokeWidth="2" strokeLinecap="round"><polyline points="9 18 15 12 9 6" /></svg></span></div><div style={{display:'flex', justifyContent:'space-between', alignItems:'center', padding:'13px 16px'}}><span style={{fontSize:'13px', color:C.t1}}>Disponibile</span><span style={{fontFamily:"'JetBrains Mono',monospace", fontWeight:'700', fontSize:'14px', color:categoryDetail.availColor}}>{categoryDetail.availText}</span></div></div><div style={{fontSize:'11px', color:C.t2, fontWeight:'700', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:'8px'}}>Obiettivo</div><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', padding:'20px', marginBottom:'20px', textAlign:'center'}}>{(categoryDetail.hasTarget) ? (<React.Fragment><div style={{width:'64px', height:'64px', borderRadius:'50%', border:'3px solid '+(categoryDetail.targetFunded?'#3ecf8e':'#5b8def'), display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 12px'}}>{(categoryDetail.targetFunded) ? (<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#3ecf8e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>) : (<span style={{fontFamily:"'JetBrains Mono',monospace", fontWeight:'700', fontSize:'12px'}}>{categoryDetail.toGoText}</span>)}</div>{(categoryDetail.targetFunded) ? (<React.Fragment><div style={{display:'inline-block', padding:'6px 14px', background:'rgba(62,207,142,0.14)', color:'#3ecf8e', borderRadius:'999px', fontWeight:'700', fontSize:'13px', marginBottom:'10px'}}>Obiettivo raggiunto!</div></React.Fragment>) : null}<div style={{fontWeight:'700', fontSize:'14px', marginBottom:'2px'}}>Accantona altri {categoryDetail.targetAmountText}</div><div style={{fontSize:'12.5px', color:C.t2, marginBottom:'16px'}}>{categoryDetail.targetDueLabel}</div><div style={{textAlign:'left', display:'flex', flexDirection:'column', gap:'6px', fontSize:'13px', paddingTop:'12px', borderTop:'1px solid '+C.b1}}><div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:C.t2}}>Importo da assegnare questo mese</span><b>{categoryDetail.neededThisMonthText}</b></div><div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:C.t2}}>Assegnato finora</span><b>{categoryDetail.assignedSoFarText}</b></div><div style={{display:'flex', justifyContent:'space-between'}}><span style={{color:C.t2}}>Mancano</span><b>{categoryDetail.toGoText}</b></div></div><button onClick={categoryDetail.onOpenTarget} style={{width:'100%', marginTop:'16px', padding:'11px', background:'#5b8def', border:'none', borderRadius:'10px', color:'#fff', fontWeight:'700', fontSize:'13.5px', cursor:'pointer'}}>Modifica obiettivo</button><label style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginTop:'12px', fontSize:'12.5px', color:C.t1, cursor:'pointer'}}><span>Metti in pausa per questo mese</span><input type="checkbox" checked={categoryDetail.snoozed} onChange={categoryDetail.onToggleSnooze} style={{width:'16px', height:'16px', accentColor:'#5b8def', cursor:'pointer'}} /></label></React.Fragment>) : (<React.Fragment><div style={{color:C.t2, fontSize:'13px', marginBottom:'12px'}}>Nessun obiettivo per questa categoria.</div><button onClick={categoryDetail.onOpenTarget} style={{padding:'10px 18px', background:'#5b8def', border:'none', borderRadius:'10px', color:'#fff', fontWeight:'700', fontSize:'13px', cursor:'pointer'}}>Crea obiettivo</button></React.Fragment>)}</div><div style={{fontSize:'11px', color:C.t2, fontWeight:'700', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:'8px'}}>Note</div><textarea value={categoryDetail.noteVal} onChange={categoryDetail.onNote} onBlur={categoryDetail.onNoteBlur} placeholder="Aggiungi una nota per questo mese..." style={{width:'100%', minHeight:'70px', padding:'12px', background:C.bg2, border:'1px solid '+C.b1, borderRadius:'12px', color:C.t0, fontSize:'13px', fontFamily:'inherit', resize:'vertical', marginBottom:'20px'}}></textarea><button onClick={categoryDetail.onAddTransaction} style={{width:'100%', padding:'12px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'10px', color:C.t0, fontWeight:'600', fontSize:'13.5px', cursor:'pointer', marginBottom:'24px'}}>+ Transazione</button><div style={{display:'flex', flexDirection:'column', gap:'8px', paddingTop:'12px', borderTop:'1px solid '+C.b1}}><button onClick={categoryDetail.onRename} style={{padding:'11px', background:'none', border:'1px solid '+C.b2, borderRadius:'10px', color:C.t0, fontWeight:'600', fontSize:'13px', cursor:'pointer'}}>Rinomina categoria</button><button onClick={categoryDetail.onHide} style={{padding:'11px', background:'none', border:'1px solid '+C.b2, borderRadius:'10px', color:C.t0, fontWeight:'600', fontSize:'13px', cursor:'pointer'}}>Nascondi categoria</button><button onClick={categoryDetail.onDelete} style={{padding:'11px', background:'none', border:'1px solid '+C.delBorder, borderRadius:'10px', color:'#f0616d', fontWeight:'600', fontSize:'13px', cursor:'pointer'}}>Elimina categoria</button></div></div></div></React.Fragment>) : null}{(targetEditorVM) ? (<React.Fragment><div style={{position:'fixed', inset:'0', zIndex:'90', background:C.bg0, overflowY:'auto'}}><div style={{display:'flex', alignItems:'center', gap:'12px', padding:'16px 18px', borderBottom:'1px solid '+C.b1}}><button onClick={targetEditorVM.onClose} style={{width:'32px', height:'32px', display:'flex', alignItems:'center', justifyContent:'center', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, cursor:'pointer'}}>×</button><h2 style={{margin:'0', fontSize:'17px', fontWeight:'700', flex:'1'}}>Obiettivo</h2><button onClick={targetEditorVM.onSave} style={{padding:'8px 16px', background:'#5b8def', border:'none', borderRadius:'9px', color:'#fff', fontWeight:'700', fontSize:'13px', cursor:'pointer'}}>Salva</button></div><div style={{maxWidth:'480px', margin:'0 auto', padding:'18px'}}><div style={{display:'flex', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'10px', padding:'3px', marginBottom:'20px'}}><button onClick={targetEditorVM.setTypeWeekly} style={{flex:'1', padding:'9px', border:'none', borderRadius:'8px', fontSize:'12.5px', fontWeight:'600', cursor:'pointer', background:targetEditorVM.type==='weekly'?'#5b8def':'transparent', color:targetEditorVM.type==='weekly'?'#fff':C.t1}}>Settimanale</button><button onClick={targetEditorVM.setTypeMonthly} style={{flex:'1', padding:'9px', border:'none', borderRadius:'8px', fontSize:'12.5px', fontWeight:'600', cursor:'pointer', background:targetEditorVM.type==='monthly'?'#5b8def':'transparent', color:targetEditorVM.type==='monthly'?'#fff':C.t1}}>Mensile</button><button onClick={targetEditorVM.setTypeYearly} style={{flex:'1', padding:'9px', border:'none', borderRadius:'8px', fontSize:'12.5px', fontWeight:'600', cursor:'pointer', background:targetEditorVM.type==='yearly'?'#5b8def':'transparent', color:targetEditorVM.type==='yearly'?'#fff':C.t1}}>Annuale</button><button onClick={targetEditorVM.setTypeCustom} style={{flex:'1', padding:'9px', border:'none', borderRadius:'8px', fontSize:'12.5px', fontWeight:'600', cursor:'pointer', background:targetEditorVM.type==='custom'?'#5b8def':'transparent', color:targetEditorVM.type==='custom'?'#fff':C.t1}}>Personalizzato</button></div><label style={{display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600', marginBottom:'16px'}}>Mi servono<input type="text" inputMode="decimal" value={targetEditorVM.amount} onChange={targetEditorVM.onAmount} placeholder="0,00" style={{padding:'11px 12px', background:C.bg2, border:'1px solid '+C.b2, borderRadius:'10px', color:C.t0, fontSize:'16px', fontFamily:"'JetBrains Mono',monospace"}} /></label>{(targetEditorVM.type==='monthly') ? (<React.Fragment><label style={{display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600', marginBottom:'16px'}}>Entro il giorno<select value={targetEditorVM.day} onChange={targetEditorVM.onDay} style={{padding:'11px 12px', background:C.bg2, border:'1px solid '+C.b2, borderRadius:'10px', color:C.t0, fontSize:'14px'}}>{(targetEditorVM.dayOptions||[]).map((o,oi)=>(<React.Fragment key={oi}><option value={o.value}>{o.label}</option></React.Fragment>))}</select></label></React.Fragment>) : null}{(targetEditorVM.type==='weekly') ? (<React.Fragment><label style={{display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600', marginBottom:'16px'}}>Ogni<select value={targetEditorVM.day} onChange={targetEditorVM.onDay} style={{padding:'11px 12px', background:C.bg2, border:'1px solid '+C.b2, borderRadius:'10px', color:C.t0, fontSize:'14px'}}>{(targetEditorVM.weekdayOptions||[]).map((o,oi)=>(<React.Fragment key={oi}><option value={o.value}>{o.label}</option></React.Fragment>))}</select></label></React.Fragment>) : null}{(targetEditorVM.type==='yearly') ? (<React.Fragment><label style={{display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600', marginBottom:'16px'}}>Entro il giorno (MM-GG)<input type="text" value={targetEditorVM.date} onChange={targetEditorVM.onDate} placeholder="12-25" style={{padding:'11px 12px', background:C.bg2, border:'1px solid '+C.b2, borderRadius:'10px', color:C.t0, fontSize:'14px'}} /></label></React.Fragment>) : null}{(targetEditorVM.type==='custom') ? (<React.Fragment><label style={{display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600', marginBottom:'16px'}}>Entro la data<input type="date" value={targetEditorVM.date} onChange={targetEditorVM.onDate} style={{padding:'11px 12px', background:C.bg2, border:'1px solid '+C.b2, borderRadius:'10px', color:C.t0, fontSize:'14px'}} /></label></React.Fragment>) : null}<label style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 0', borderTop:'1px solid '+C.b1, fontSize:'13px', color:C.t1, cursor:'pointer'}}><span>Ripeti automaticamente ogni periodo</span><input type="checkbox" checked={targetEditorVM.repeat} onChange={targetEditorVM.onToggleRepeat} style={{width:'16px', height:'16px', accentColor:'#5b8def', cursor:'pointer'}} /></label>{(targetEditorVM.hasExistingTarget) ? (<React.Fragment><button onClick={targetEditorVM.onDelete} style={{width:'100%', marginTop:'24px', padding:'12px', background:'rgba(240,97,109,0.12)', border:'1px solid '+C.delBorder, borderRadius:'10px', color:'#f0616d', fontWeight:'700', fontSize:'13.5px', cursor:'pointer'}}>Elimina obiettivo</button></React.Fragment>) : null}</div></div></React.Fragment>) : null}{(moveMoneyVM) ? (<React.Fragment><div style={{position:'fixed', inset:'0', zIndex:'85', background:C.bg0, overflowY:'auto', display:'flex', flexDirection:'column'}}><div style={{background:'linear-gradient(160deg,#3ecf8e,#2fae74)', color:'#fff', padding:'20px 20px 28px', position:'relative', flexShrink:'0'}}><button onClick={moveMoneyVM.onClose} style={{position:'absolute', top:'16px', left:'16px', width:'32px', height:'32px', borderRadius:'50%', background:'rgba(255,255,255,0.25)', border:'none', color:'#fff', fontSize:'18px', cursor:'pointer'}}>×</button><div style={{textAlign:'center', fontSize:'12px', fontWeight:'700', textTransform:'uppercase', letterSpacing:'0.5px', opacity:'0.9', marginBottom:'6px'}}>Sposta da</div><div style={{textAlign:'center', fontSize:'16px', fontWeight:'700', marginBottom:'10px'}}>{moveMoneyVM.fromName}</div><input type="text" inputMode="decimal" value={moveMoneyVM.amount} onChange={moveMoneyVM.onAmount} style={{display:'block', margin:'0 auto', width:'200px', textAlign:'center', fontSize:'32px', fontWeight:'700', background:'rgba(255,255,255,0.18)', border:'none', borderRadius:'12px', color:'#fff', padding:'10px', fontFamily:"'JetBrains Mono',monospace"}} /><div style={{textAlign:'center', fontSize:'11.5px', opacity:'0.85', marginTop:'6px'}}>Disponibile: {moveMoneyVM.fromAvailText}</div><div style={{display:'flex', justifyContent:'center', margin:'14px 0 6px'}}><div style={{width:'34px', height:'34px', borderRadius:'50%', background:'rgba(255,255,255,0.25)', display:'flex', alignItems:'center', justifyContent:'center'}}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="19 12 12 19 5 12" /><line x1="12" y1="19" x2="12" y2="5" /></svg></div></div><div style={{textAlign:'center', fontSize:'12px', fontWeight:'700', textTransform:'uppercase', letterSpacing:'0.5px', opacity:'0.9'}}>Verso</div></div><div style={{padding:'18px', maxWidth:'480px', margin:'0 auto', width:'100%', flex:'1'}}><button onClick={moveMoneyVM.onOpenPicker} style={{width:'100%', padding:'14px', background:C.bg1, border:'1px dashed '+C.b3, borderRadius:'12px', color: moveMoneyVM.hasTarget?C.t0:C.t2, fontWeight:'600', fontSize:'14px', cursor:'pointer', textAlign:'center'}}>{moveMoneyVM.hasTarget ? (moveMoneyVM.toLabel+' · disp. '+moveMoneyVM.toAvailText) : '+ Seleziona categoria'}</button><button onClick={moveMoneyVM.onDone} disabled={!moveMoneyVM.canDone} style={{width:'100%', marginTop:'20px', padding:'14px', background: moveMoneyVM.canDone?'#5b8def':C.b2, border:'none', borderRadius:'12px', color: moveMoneyVM.canDone?'#fff':C.t3, fontWeight:'700', fontSize:'14.5px', cursor: moveMoneyVM.canDone?'pointer':'default'}}>Fatto</button></div></div>{(moveMoneyVM.pickerOpen) ? (<React.Fragment><div style={{position:'fixed', inset:'0', zIndex:'86', background:'rgba(0,0,0,0.4)'}} onClick={moveMoneyVM.onClosePicker}></div><div style={{position:'fixed', left:'0', right:'0', bottom:'0', zIndex:'87', maxHeight:'80vh', display:'flex', flexDirection:'column', background:C.bg0, borderRadius:'18px 18px 0 0', boxShadow:'0 -10px 30px rgba(0,0,0,0.3)'}}><div style={{padding:'14px 18px 10px', borderBottom:'1px solid '+C.b1, flexShrink:'0'}}><div style={{width:'36px', height:'4px', background:C.b3, borderRadius:'3px', margin:'0 auto 12px'}}></div><div style={{fontWeight:'700', fontSize:'15px', marginBottom:'10px'}}>Sposta verso</div><input type="text" value={moveMoneyVM.search} onChange={moveMoneyVM.onSearch} placeholder="Cerca categorie" style={{width:'100%', padding:'10px 12px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'10px', color:C.t0, fontSize:'14px'}} /></div><div style={{overflowY:'auto', padding:'10px 18px 24px'}}>{(moveMoneyVM.readyMatches) ? (<React.Fragment><div style={{fontSize:'11px', fontWeight:'700', textTransform:'uppercase', letterSpacing:'0.5px', color:C.t3, margin:'10px 0 6px'}}>Afflusso</div><div onClick={moveMoneyVM.onSelectReady} style={{display:'flex', justifyContent:'space-between', alignItems:'center', padding:'12px 14px', background:C.bg2, border:'1px solid '+C.b1, borderRadius:'10px', cursor:'pointer', marginBottom:'14px'}}><span style={{fontWeight:'600', fontSize:'13.5px'}}>Pronto per assegnare</span><span style={{fontFamily:"'JetBrains Mono',monospace", fontWeight:'700', color:'#3ecf8e'}}>{moveMoneyVM.readyToAssignText}</span></div></React.Fragment>) : null}{(moveMoneyVM.pickerGroups || []).map((grp, gi) => (<React.Fragment key={gi}><div style={{fontSize:'11px', fontWeight:'700', textTransform:'uppercase', letterSpacing:'0.5px', color:C.t3, margin:'10px 0 6px'}}>{grp.name}</div><div style={{display:'flex', flexDirection:'column', gap:'2px', marginBottom:'10px'}}>{(grp.cats || []).map((c, ci) => (<React.Fragment key={ci}><div onClick={c.onClick} style={{display:'flex', justifyContent:'space-between', alignItems:'center', padding:'11px 14px', borderRadius:'9px', cursor:'pointer'}} {...hoverStyle({display:'flex', justifyContent:'space-between', alignItems:'center', padding:'11px 14px', borderRadius:'9px', cursor:'pointer'}, {background:C.bg1})}><span style={{fontSize:'13.5px'}}>{c.name}</span><span style={{fontFamily:"'JetBrains Mono',monospace", fontSize:'13px', color:C.t1}}>{c.availText}</span></div></React.Fragment>))}</div></React.Fragment>))}</div></div></React.Fragment>) : null}</React.Fragment>) : null}{/* ============ MOVIMENTI ============ */}{(isTransactions) ? (<React.Fragment><div style={{maxWidth:'1080px', margin:'0 auto'}}><div style={{display:'flex', justifyContent:'flex-end', gap:'8px', marginBottom:'14px'}}><button onClick={onExportCsv} style={{display:'inline-flex', alignItems:'center', gap:'7px', padding:'8px 13px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, fontSize:'12.5px', fontWeight:'600', cursor:'pointer'}} {...hoverStyle({display:'inline-flex', alignItems:'center', gap:'7px', padding:'8px 13px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, fontSize:'12.5px', fontWeight:'600', cursor:'pointer'}, {borderColor:C.b4})}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><polyline points="7 11 12 16 17 11" /><path d="M5 20h14" /></svg>
            Esporta CSV
          </button><button onClick={onImportCsv} style={{display:'inline-flex', alignItems:'center', gap:'7px', padding:'8px 13px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, fontSize:'12.5px', fontWeight:'600', cursor:'pointer'}} {...hoverStyle({display:'inline-flex', alignItems:'center', gap:'7px', padding:'8px 13px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, fontSize:'12.5px', fontWeight:'600', cursor:'pointer'}, {borderColor:C.b4})}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4" /><polyline points="7 9 12 4 17 9" /><path d="M5 20h14" /></svg>
            Importa CSV
          </button></div><div style={{display:'flex', alignItems:'flex-end', gap:'12px', flexWrap:'wrap', marginBottom:'18px'}}><label style={{flex:'1 1 240px', display:'flex', flexDirection:'column', gap:'5px', fontSize:'11px', color:C.t2, fontWeight:'600'}}>Cerca<input type="search" value={filters.search||''} onChange={onFilter} data-filter="search" placeholder="Cerca..." style={{padding:'8px 10px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, fontSize:'13px', fontWeight:'500'}} /></label><label style={{display:'flex', flexDirection:'column', gap:'5px', fontSize:'11px', color:C.t2, fontWeight:'600'}}>Dal
            <input type="date" value={filters.from} onChange={onFilter} data-filter="from" style={{padding:'8px 10px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, fontSize:'13px', fontWeight:'500'}} /></label><label style={{display:'flex', flexDirection:'column', gap:'5px', fontSize:'11px', color:C.t2, fontWeight:'600'}}>Al
            <input type="date" value={filters.to} onChange={onFilter} data-filter="to" style={{padding:'8px 10px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, fontSize:'13px', fontWeight:'500'}} /></label><label style={{display:'flex', flexDirection:'column', gap:'5px', fontSize:'11px', color:C.t2, fontWeight:'600'}}>Conto
            <select value={filters.accountId} onChange={onFilter} data-filter="accountId" style={{padding:'8px 10px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, fontSize:'13px', fontWeight:'500', minWidth:'150px'}}><option value="">Tutti</option>{(accountFilterOptions || []).map((opt, optIdx) => (<React.Fragment key={optIdx}><option value={opt.value}>{opt.label}</option></React.Fragment>))}</select></label><label style={{display:'flex', flexDirection:'column', gap:'5px', fontSize:'11px', color:C.t2, fontWeight:'600'}}>Categoria
            <select value={filters.categoryId} onChange={onFilter} data-filter="categoryId" style={{padding:'8px 10px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, fontSize:'13px', fontWeight:'500', minWidth:'150px'}}><option value="">Tutte</option>{(categoryFilterOptions || []).map((opt, optIdx) => (<React.Fragment key={optIdx}><option value={opt.value}>{opt.label}</option></React.Fragment>))}</select></label><label style={{display:'flex', flexDirection:'column', gap:'5px', fontSize:'11px', color:C.t2, fontWeight:'600'}}>Tipo
            <select value={filters.type} onChange={onFilter} data-filter="type" style={{padding:'8px 10px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, fontSize:'13px', fontWeight:'500', minWidth:'130px'}}><option value="">Tutti</option><option value="Income">Entrata</option><option value="Expense">Uscita</option><option value="Transfer">Trasferimento</option></select></label>{(hasFilters) ? (<React.Fragment><button onClick={clearFilters} style={{padding:'8px 12px', background:'transparent', border:'1px solid '+C.b2, borderRadius:'9px', color:C.t1, fontSize:'12.5px', fontWeight:'500', cursor:'pointer', height:'35px'}} {...hoverStyle({padding:'8px 12px', background:'transparent', border:'1px solid '+C.b2, borderRadius:'9px', color:C.t1, fontSize:'12.5px', fontWeight:'500', cursor:'pointer', height:'35px'}, {borderColor:C.b4, color:C.t0})}>Azzera filtri</button></React.Fragment>) : null}</div><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'10px', marginBottom:'10px', minHeight:'32px'}}><label style={{display:'flex', alignItems:'center', gap:'8px', fontSize:'12.5px', color:C.t1, cursor:'pointer'}}><input type="checkbox" checked={allTxnSelected} onChange={onToggleSelectAllTxns} style={{width:'16px', height:'16px', accentColor:'#5b8def', cursor:'pointer'}} />Seleziona tutti</label>{(hasTxnSelection) ? (<React.Fragment><div style={{display:'flex', alignItems:'center', gap:'10px'}}><span style={{fontSize:'12.5px', color:C.chipBlue, fontWeight:'600'}}>{selectedTxnCount} selezionat{selectedTxnCount===1?'o':'i'}</span><button onClick={onDeleteSelectedTxns} style={{display:'inline-flex', alignItems:'center', gap:'6px', padding:'7px 12px', background:'rgba(240,97,109,0.12)', border:'1px solid rgba(240,97,109,0.35)', borderRadius:'8px', color:'#f0616d', fontSize:'12.5px', fontWeight:'600', cursor:'pointer'}} {...hoverStyle({display:'inline-flex', alignItems:'center', gap:'6px', padding:'7px 12px', background:'rgba(240,97,109,0.12)', border:'1px solid rgba(240,97,109,0.35)', borderRadius:'8px', color:'#f0616d', fontSize:'12.5px', fontWeight:'600', cursor:'pointer'}, {background:'#f0616d', color:'#fff'})}>Elimina selezionati</button><button onClick={onClearTxnSelection} style={{background:'none', border:'none', color:C.t2, fontSize:'12.5px', fontWeight:'600', cursor:'pointer', padding:'0'}}>Annulla</button></div></React.Fragment>) : null}</div><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', overflow:'hidden'}}>{(txnRows || []).map((t, tIdx) => (<React.Fragment key={tIdx}><div {...hoverStyle(t.rowStyle, {background: t.selected ? 'rgba(91,141,239,0.14)' : C.bg1})}><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'10px'}}><div style={{display:'flex', alignItems:'center', gap:'9px'}}><input type="checkbox" checked={t.selected} onChange={t.onToggleSelect} style={{width:'15px', height:'15px', accentColor:'#5b8def', cursor:'pointer', flexShrink:'0'}} /><span style={{fontFamily:'\'JetBrains Mono\',monospace', fontSize:'11px', color:C.t3}}>{t.dateLabel}</span></div><div style={{display:'flex', gap:'2px'}}><button onClick={t.onEdit} title="Modifica" style={{width:'25px', height:'25px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'7px', color:C.t2, cursor:'pointer', flexShrink:'0'}} {...hoverStyle({width:'25px', height:'25px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'7px', color:C.t2, cursor:'pointer', flexShrink:'0'}, {borderColor:C.b4, color:C.t0})}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg></button><button onClick={t.onDelete} title="Elimina" style={{width:'25px', height:'25px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'7px', color:C.t2, cursor:'pointer', flexShrink:'0'}} {...hoverStyle({width:'25px', height:'25px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'7px', color:C.t2, cursor:'pointer', flexShrink:'0'}, {borderColor:C.delBorder, color:'#f0616d'})}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 21 6" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /></svg></button></div></div><div style={{display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:'12px'}}><div style={{minWidth:'0', flex:'1'}}><div style={{fontWeight:'700', fontSize:'14.5px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{t.description}</div>{(t.hasSub) ? (<React.Fragment><div style={{fontSize:'11.5px', color:C.t3, marginTop:'1px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{t.subLabel}</div></React.Fragment>) : null}</div><div style={{display:'flex', alignItems:'center', gap:'6px', flexShrink:'0'}}><span title={t.clearedTitle} style={t.clearedStyle}></span><span style={t.amountStyle}>{t.amountText}</span></div></div><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'10px'}}><span style={t.tagStyle}>{t.categoryName}</span><span style={{fontSize:'11.5px', color:C.t2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', textAlign:'right'}}>{t.accountName}</span></div></div></React.Fragment>))}{(txnEmpty) ? (<React.Fragment><div style={{padding:'52px 18px', textAlign:'center', color:C.t2}}>Nessun movimento{emptyFilterSuffix}.</div></React.Fragment>) : null}</div></div></React.Fragment>) : null}{/* ============ CONTI ============ */}{(isAccounts) ? (<React.Fragment><div style={{maxWidth:'1000px', margin:'0 auto', display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))', gap:'16px'}}>{(accountCards || []).map((a, aIdx) => (<React.Fragment key={aIdx}><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', padding:'18px'}} {...hoverStyle({background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', padding:'18px'}, {borderColor:C.b4})}><div style={{display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:'10px'}}><div style={{minWidth:'0'}}><div style={{fontWeight:'700', fontSize:'15px', letterSpacing:'-0.2px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{a.name}</div><div style={{fontSize:'12.5px', color:C.t2, marginTop:'2px'}}>{a.bank}</div></div><div style={{display:'flex', gap:'4px', flexShrink:'0'}}><button onClick={a.onMoveUp} disabled={a.moveUpDisabled} title="Sposta su" style={Object.assign({}, a.moveBtnStyle, {opacity:a.moveUpDisabled?0.35:1, cursor:a.moveUpDisabled?'default':'pointer'})}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 15 12 9 18 15" /></svg></button><button onClick={a.onMoveDown} disabled={a.moveDownDisabled} title="Sposta giu" style={Object.assign({}, a.moveBtnStyle, {opacity:a.moveDownDisabled?0.35:1, cursor:a.moveDownDisabled?'default':'pointer'})}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg></button><button onClick={a.onEdit} title="Modifica" style={{width:'28px', height:'28px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'7px', color:C.t2, cursor:'pointer'}} {...hoverStyle({width:'28px', height:'28px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'7px', color:C.t2, cursor:'pointer'}, {borderColor:C.b4, color:C.t0})}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg></button><button onClick={a.onDelete} title="Elimina" style={{width:'28px', height:'28px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'7px', color:C.t2, cursor:'pointer'}} {...hoverStyle({width:'28px', height:'28px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'7px', color:C.t2, cursor:'pointer'}, {borderColor:C.delBorder, color:'#f0616d'})}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 21 6" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /></svg></button></div></div><div style={{marginTop:'16px'}}><div style={{fontSize:'11px', color:C.t2, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.4px'}}>Saldo attuale</div><div style={a.balanceStyle}>{a.balanceText}</div></div><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginTop:'14px', paddingTop:'14px', borderTop:'1px solid '+C.b1}}><div style={{display:'flex', gap:'6px', alignItems:'center', minWidth:'0'}}><span style={a.typeBadgeStyle}>{a.typeLabel}</span><span style={a.budgetBadgeStyle}>{a.budgetBadgeLabel}</span><span style={a.showTxnBadgeStyle}>{a.showTxnBadgeLabel}</span></div><span style={{fontSize:'11.5px', color:C.t3, whiteSpace:'nowrap'}}>iniz. {a.initialText}</span></div></div></React.Fragment>))}{(accountsEmpty) ? (<React.Fragment><div style={{gridColumn:'1/-1', padding:'52px', textAlign:'center', color:C.t2, background:C.bg2, border:'1px dashed '+C.b2, borderRadius:'14px'}}>Nessun conto. Aggiungine uno per iniziare.</div></React.Fragment>) : null}</div></React.Fragment>) : null}{/* ============ CATEGORIE ============ */}{(isCategories) ? (<React.Fragment><div style={{maxWidth:'900px', margin:'0 auto', display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(300px,1fr))', gap:'20px'}}><div><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'12px'}}><h3 style={{margin:'0', fontSize:'13px', fontWeight:'700', textTransform:'uppercase', letterSpacing:'0.5px', color:'#3ecf8e'}}>Entrate</h3><button onClick={onNewIncomeCat} style={{fontSize:'12px', color:'#5b8def', background:'none', border:'none', cursor:'pointer', fontWeight:'600'}}>+ Aggiungi</button></div><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'12px', overflow:'hidden'}}>{(incomeCats || []).map((c, cIdx) => (<React.Fragment key={cIdx}><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding:'13px 16px', borderBottom:'1px solid '+C.b0}} {...hoverStyle({display:'flex', alignItems:'center', justifyContent:'space-between', padding:'13px 16px', borderBottom:'1px solid '+C.b0}, {background:C.bg1})}><span style={{fontWeight:'600', fontSize:'13.5px'}}>{c.name}</span><div style={{display:'flex', gap:'4px'}}><button onClick={c.onEdit} style={{width:'26px', height:'26px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:C.t2, cursor:'pointer'}} {...hoverStyle({width:'26px', height:'26px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:C.t2, cursor:'pointer'}, {borderColor:C.b4, color:C.t0})}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg></button><button onClick={c.onDelete} style={{width:'26px', height:'26px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:C.t2, cursor:'pointer'}} {...hoverStyle({width:'26px', height:'26px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:C.t2, cursor:'pointer'}, {borderColor:C.delBorder, color:'#f0616d'})}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 21 6" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /></svg></button></div></div></React.Fragment>))}{(incomeEmpty) ? (<React.Fragment><div style={{padding:'24px', textAlign:'center', color:C.t2, fontSize:'13px'}}>Nessuna categoria</div></React.Fragment>) : null}</div></div><div><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'12px'}}><h3 style={{margin:'0', fontSize:'13px', fontWeight:'700', textTransform:'uppercase', letterSpacing:'0.5px', color:'#f0616d'}}>Uscite</h3><div style={{display:'flex', gap:'14px'}}><button onClick={onNewGroup} style={{fontSize:'12px', color:'#5b8def', background:'none', border:'none', cursor:'pointer', fontWeight:'600'}}>+ Gruppo</button><button onClick={onNewExpenseCat} style={{fontSize:'12px', color:'#5b8def', background:'none', border:'none', cursor:'pointer', fontWeight:'600'}}>+ Categoria</button></div></div><div style={{display:'flex', flexDirection:'column', gap:'16px'}}>{(expenseGroups || []).map((grp, grpIdx) => (<React.Fragment key={grpIdx}><div><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'7px', paddingLeft:'2px', minHeight:'22px'}}><span style={{fontSize:'11px', fontWeight:'700', textTransform:'uppercase', letterSpacing:'0.5px', color:C.t4}}>{grp.name}</span>{(grp.isReal) ? (<React.Fragment><div style={{display:'flex', gap:'4px'}}><button onClick={grp.onEditGroup} title="Rinomina gruppo" style={{width:'24px', height:'24px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:C.t2, cursor:'pointer'}} {...hoverStyle({width:'24px', height:'24px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:C.t2, cursor:'pointer'}, {borderColor:C.b4, color:C.t0})}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg></button><button onClick={grp.onDeleteGroup} title="Elimina gruppo" style={{width:'24px', height:'24px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:C.t2, cursor:'pointer'}} {...hoverStyle({width:'24px', height:'24px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:C.t2, cursor:'pointer'}, {borderColor:C.delBorder, color:'#f0616d'})}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 21 6" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /></svg></button></div></React.Fragment>) : null}</div><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'12px', overflow:'hidden'}}>{(grp.cats || []).map((c, cIdx) => (<React.Fragment key={cIdx}><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 16px', borderBottom:'1px solid '+C.b0}} {...hoverStyle({display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 16px', borderBottom:'1px solid '+C.b0}, {background:C.bg1})}><div style={{minWidth:'0'}}><div style={{fontWeight:'600', fontSize:'13.5px'}}>{c.name}</div>{(c.hasTarget) ? (<React.Fragment><div style={{fontSize:'11px', color:C.t3, marginTop:'2px'}}>{c.targetText}</div></React.Fragment>) : null}</div><div style={{display:'flex', gap:'4px'}}><button onClick={c.onEdit} style={{width:'26px', height:'26px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:C.t2, cursor:'pointer'}} {...hoverStyle({width:'26px', height:'26px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:C.t2, cursor:'pointer'}, {borderColor:C.b4, color:C.t0})}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg></button><button onClick={c.onDelete} style={{width:'26px', height:'26px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:C.t2, cursor:'pointer'}} {...hoverStyle({width:'26px', height:'26px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:C.t2, cursor:'pointer'}, {borderColor:C.delBorder, color:'#f0616d'})}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 21 6" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /></svg></button></div></div></React.Fragment>))}{(grp.isEmptyReal) ? (<React.Fragment><div style={{padding:'14px 16px', fontSize:'12px', color:C.t3}}>Gruppo vuoto — assegna categorie modificandole.</div></React.Fragment>) : null}</div></div></React.Fragment>))}{(expenseEmpty) ? (<React.Fragment><div style={{padding:'24px', textAlign:'center', color:C.t2, fontSize:'13px', background:C.bg2, border:'1px solid '+C.b1, borderRadius:'12px'}}>Nessuna categoria</div></React.Fragment>) : null}{(hiddenCats && hiddenCats.length>0) ? (<React.Fragment><div style={{marginTop:'8px'}}><div style={{fontSize:'11px', fontWeight:'700', textTransform:'uppercase', letterSpacing:'0.5px', color:C.t3, marginBottom:'7px', paddingLeft:'2px'}}>Nascoste</div><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'12px', overflow:'hidden'}}>{(hiddenCats || []).map((c, cIdx) => (<React.Fragment key={cIdx}><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 16px', borderBottom:'1px solid '+C.b0}}><span style={{fontWeight:'600', fontSize:'13.5px', color:C.t3}}>{c.name}</span><div style={{display:'flex', gap:'8px', alignItems:'center'}}><button onClick={c.onShow} style={{fontSize:'12px', color:'#5b8def', background:'none', border:'none', cursor:'pointer', fontWeight:'600'}}>Mostra</button><button onClick={c.onDelete} style={{width:'26px', height:'26px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:C.t2, cursor:'pointer'}} {...hoverStyle({width:'26px', height:'26px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:C.t2, cursor:'pointer'}, {borderColor:C.delBorder, color:'#f0616d'})}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 21 6" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /></svg></button></div></div></React.Fragment>))}</div></div></React.Fragment>) : null}</div></div></div></React.Fragment>) : null}</div></main>{(isMobile) ? (<React.Fragment><nav style={{position:'fixed', left:'0', right:'0', bottom:'0', zIndex:'45', display:'flex', background:C.bg1, borderTop:'1px solid '+C.b1, paddingBottom:'env(safe-area-inset-bottom)'}}><button onClick={goDashboard} style={{flex:'1', display:'flex', flexDirection:'column', alignItems:'center', gap:'3px', padding:'8px 2px 7px', background:'none', border:'none', color: isDashboard?'#5b8def':C.t2, cursor:'pointer'}}><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="8" height="10" rx="1.5" /><rect x="13" y="3" width="8" height="6" rx="1.5" /><rect x="3" y="15" width="8" height="6" rx="1.5" /><rect x="13" y="11" width="8" height="10" rx="1.5" /></svg><span style={{fontSize:'10px', fontWeight:'600'}}>Home</span></button><button onClick={goBudget} style={{flex:'1', display:'flex', flexDirection:'column', alignItems:'center', gap:'3px', padding:'8px 2px 7px', background:'none', border:'none', color: isBudget?'#5b8def':C.t2, cursor:'pointer'}}><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></svg><span style={{fontSize:'10px', fontWeight:'600'}}>Budget</span></button><button onClick={goTransactions} style={{flex:'1', display:'flex', flexDirection:'column', alignItems:'center', gap:'3px', padding:'8px 2px 7px', background:'none', border:'none', color: isTransactions?'#5b8def':C.t2, cursor:'pointer'}}><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="13" y2="17" /></svg><span style={{fontSize:'10px', fontWeight:'600'}}>Movimenti</span></button><button onClick={goAccounts} style={{flex:'1', display:'flex', flexDirection:'column', alignItems:'center', gap:'3px', padding:'8px 2px 7px', background:'none', border:'none', color: isAccounts?'#5b8def':C.t2, cursor:'pointer'}}><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="6" width="18" height="12" rx="2" /><line x1="3" y1="10.5" x2="21" y2="10.5" /></svg><span style={{fontSize:'10px', fontWeight:'600'}}>Conti</span></button><button onClick={goCategories} style={{flex:'1', display:'flex', flexDirection:'column', alignItems:'center', gap:'3px', padding:'8px 2px 7px', background:'none', border:'none', color: isCategories?'#5b8def':C.t2, cursor:'pointer'}}><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></svg><span style={{fontSize:'10px', fontWeight:'600'}}>Categorie</span></button></nav></React.Fragment>) : null}{/* ============ MODALE ============ */}{(modalOpen) ? (<React.Fragment><div style={{position:'fixed', inset:'0', zIndex:'60', display:'flex', alignItems:'center', justifyContent:'center', padding:'20px', background:'rgba(0,0,0,0.6)', animation:'fpOverlay .18s ease'}} onClick={onBackdrop}><div style={{width:'100%', maxWidth:'460px', maxHeight:'90vh', overflowY:'auto', background:C.bg2, border:'1px solid '+C.b3, borderRadius:'16px', boxShadow:'0 24px 60px rgba(0,0,0,0.55)', animation:'fpFade .22s cubic-bezier(.2,.8,.3,1)'}} data-modal-card="1"><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding:'18px 20px', borderBottom:'1px solid '+C.b2}}><h2 style={{margin:'0', fontSize:'16px', fontWeight:'700'}}>{modalTitle}</h2><button onClick={onClose} style={{width:'30px', height:'30px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'none', borderRadius:'8px', color:C.t2, cursor:'pointer', fontSize:'20px'}} {...hoverStyle({width:'30px', height:'30px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'none', borderRadius:'8px', color:C.t2, cursor:'pointer', fontSize:'20px'}, {color:C.t0})}>×</button></div><div style={{padding:'20px', display:'flex', flexDirection:'column', gap:'15px'}}>{/* ACCOUNT FORM */}{(isAccountModal) ? (<React.Fragment><label style={{display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600'}}>Nome
              <input type="text" value={data.name} onChange={onField} data-field="name" placeholder="es. Conto Corrente" style={{padding:'10px 12px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'9px', fontSize:'14px'}} /></label><label style={{display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600'}}>Banca / Istituto
              <input type="text" value={data.bank} onChange={onField} data-field="bank" placeholder="es. Intesa Sanpaolo" style={{padding:'10px 12px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'9px', fontSize:'14px'}} /></label><div style={{display:'flex', gap:'12px'}}><label style={{flex:'1', display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600'}}>Tipo
                <select value={data.type} onChange={onField} data-field="type" style={{padding:'10px 12px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'9px', fontSize:'14px'}}>{(accountTypeOptions || []).map((opt, optIdx) => (<React.Fragment key={optIdx}><option value={opt.value}>{opt.label}</option></React.Fragment>))}</select></label><label style={{flex:'1', display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600'}}>Saldo iniziale (€)
                <input type="text" inputMode="decimal" value={data.initialBalance} onChange={onField} data-field="initialBalance" placeholder="0,00" style={{padding:'10px 12px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'9px', fontSize:'14px', fontFamily:'\'JetBrains Mono\',monospace'}} /></label></div><label style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'12px', padding:'11px 13px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'10px', cursor:'pointer'}}><span style={{fontSize:'13px', color:C.t0, fontWeight:'600'}}>Conto nel budget<span style={{display:'block', fontSize:'11px', color:C.t2, fontWeight:'500', marginTop:'2px'}}>Disattiva per conti di monitoraggio (investimenti, pensione)</span></span><input type="checkbox" checked={data.onBudget} onChange={onField} data-field="onBudget" style={{width:'18px', height:'18px', accentColor:'#3ecf8e', cursor:'pointer', flexShrink:'0'}} /></label><label style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'12px', padding:'11px 13px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'10px', cursor:'pointer'}}><span style={{fontSize:'13px', color:C.t0, fontWeight:'600'}}>Mostra nei nuovi movimenti<span style={{display:'block', fontSize:'11px', color:C.t2, fontWeight:'500', marginTop:'2px'}}>Disattiva per conti chiusi o da tenere solo nello storico</span></span><input type="checkbox" checked={data.showInNewTransactions!==false} onChange={onField} data-field="showInNewTransactions" style={{width:'18px', height:'18px', accentColor:'#5b8def', cursor:'pointer', flexShrink:'0'}} /></label></React.Fragment>) : null}{/* TRANSACTION FORM */}{(isTransactionModal) ? (<React.Fragment><div style={{display:'flex', gap:'8px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'10px', padding:'4px'}}><button onClick={setTypeIncome} style={typeBtn.income}>Entrata</button><button onClick={setTypeExpense} style={typeBtn.expense}>Uscita</button><button onClick={setTypeTransfer} style={typeBtn.transfer}>Trasferimento</button></div><div style={{display:'flex', gap:'12px'}}><label style={{flex:'1', display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600'}}>Data
                <input type="date" value={data.date} onChange={onField} data-field="date" style={{padding:'10px 12px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'9px', fontSize:'14px'}} /></label><label style={{flex:'1', display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600'}}>Importo (€)
                <input type="text" inputMode="decimal" value={data.amount} onChange={onField} data-field="amount" placeholder="0,00" style={{padding:'10px 12px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'9px', fontSize:'14px', fontFamily:'\'JetBrains Mono\',monospace'}} /></label></div><label style={{display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600'}}>Descrizione
              <input type="text" value={data.description} onChange={onField} data-field="description" placeholder="es. Spesa Esselunga" style={{padding:'10px 12px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'9px', fontSize:'14px'}} /></label><label style={{display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600'}}>{accountFieldLabel}
              <select value={data.accountId} onChange={onField} data-field="accountId" style={{padding:'10px 12px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'9px', fontSize:'14px'}}>{(modalAccountOptions || []).map((opt, optIdx) => (<React.Fragment key={optIdx}><option value={opt.value}>{opt.label}</option></React.Fragment>))}</select></label>{(isTransferModal) ? (<React.Fragment><label style={{display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600'}}>Conto di destinazione
                <select value={data.toAccountId} onChange={onField} data-field="toAccountId" style={{padding:'10px 12px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'9px', fontSize:'14px'}}>{(modalAccountOptions || []).map((opt, optIdx) => (<React.Fragment key={optIdx}><option value={opt.value}>{opt.label}</option></React.Fragment>))}</select></label></React.Fragment>) : null}{(showCategoryField) ? (<React.Fragment><label style={{display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600'}}>Categoria
                <select value={data.categoryId} onChange={onField} data-field="categoryId" style={{padding:'10px 12px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'9px', fontSize:'14px'}}><option value="">— Nessuna —</option>{(modalCategoryOptions || []).map((opt, optIdx) => (<React.Fragment key={optIdx}><option value={opt.value}>{opt.label}</option></React.Fragment>))}</select></label></React.Fragment>) : null}<label style={{display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600'}}>Note
              <input type="text" value={data.notes} onChange={onField} data-field="notes" placeholder="Facoltative" style={{padding:'10px 12px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'9px', fontSize:'14px'}} /></label><div><div style={{fontSize:'12px', color:C.t1, fontWeight:'600', marginBottom:'6px'}}>Stato liquidazione</div><div style={{display:'flex', gap:'8px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'10px', padding:'4px'}}><button onClick={setClearedUncleared} style={clearedBtn.uncleared}>Non liquidato</button><button onClick={setClearedCleared} style={clearedBtn.cleared}>Liquidato</button><button onClick={setClearedReconciled} style={clearedBtn.reconciled}>Riconciliato</button></div></div></React.Fragment>) : null}{/* CATEGORY FORM */}{(isCategoryModal) ? (<React.Fragment><label style={{display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600'}}>Nome
              <input type="text" value={data.name} onChange={onField} data-field="name" placeholder="es. Spesa alimentare" style={{padding:'10px 12px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'9px', fontSize:'14px'}} /></label><label style={{display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600'}}>Tipo
              <select value={data.type} onChange={onField} data-field="type" style={{padding:'10px 12px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'9px', fontSize:'14px'}}><option value="Expense">Uscita</option><option value="Income">Entrata</option></select></label><label style={{display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600'}}>Gruppo
              <input type="text" list="fp-groups" value={data.group} onChange={onField} data-field="group" placeholder="es. Obblighi fissi" style={{padding:'10px 12px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'9px', fontSize:'14px'}} /><datalist id="fp-groups">{(existingGroups || []).map((g, gIdx) => (<React.Fragment key={gIdx}><option value={g}></option></React.Fragment>))}</datalist></label>{(isExpenseCatModal) ? (<React.Fragment><label style={{display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600'}}>Obiettivo mensile (€)
                <input type="text" inputMode="decimal" value={data.target} onChange={onField} data-field="target" placeholder="Facoltativo—quanto vuoi assegnare ogni mese" style={{padding:'10px 12px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'9px', fontSize:'14px', fontFamily:'\'JetBrains Mono\',monospace'}} /></label></React.Fragment>) : null}</React.Fragment>) : null}{/* MOVE FORM */}{(isMoveModal) ? (<React.Fragment><div style={{fontSize:'12.5px', color:C.t1, lineHeight:'1.6'}}>Sposta parte del denaro già assegnato a <b style={{color:C.t0}}>{moveFromName}</b> verso un'altra categoria — utile per coprire una categoria dove hai speso troppo questo mese.</div><div style={{padding:'10px 12px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'9px', display:'flex', justifyContent:'space-between', alignItems:'center'}}><span style={{fontSize:'12.5px', color:C.t1}}>Disponibile in {moveFromName}</span><span style={{fontFamily:'\'JetBrains Mono\',monospace', fontWeight:'600', fontSize:'13.5px'}}>{moveFromAvailText}</span></div><label style={{display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600'}}>Sposta verso
              <select value={data.toCategoryId} onChange={onField} data-field="toCategoryId" style={{padding:'10px 12px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'9px', fontSize:'14px'}}><option value="">— Seleziona categoria —</option>{(moveToOptions || []).map((opt, optIdx) => (<React.Fragment key={optIdx}><option value={opt.value}>{opt.label}</option></React.Fragment>))}</select></label><label style={{display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600'}}>Importo da spostare (€)
              <input type="text" inputMode="decimal" value={data.amount} onChange={onField} data-field="amount" placeholder="0,00" style={{padding:'10px 12px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'9px', fontSize:'14px', fontFamily:'\'JetBrains Mono\',monospace'}} /></label></React.Fragment>) : null}{/* IMPORT FORM */}{(isImportModal) ? (<React.Fragment><div style={{fontSize:'12.5px', color:C.t1, lineHeight:'1.6'}}>Carica un file <b style={{color:C.t0}}>CSV</b> (separatore <span style={{color:'#5b8def', fontFamily:'\'JetBrains Mono\',monospace'}}>;</span>) oppure incolla i dati qui sotto. Il conto deve corrispondere per nome; le categorie mancanti vengono create.</div><div style={{background:C.bg0, border:'1px solid '+C.b2, borderRadius:'9px', padding:'10px 12px', fontFamily:'\'JetBrains Mono\',monospace', fontSize:'11px', color:C.t2, overflowX:'auto', whiteSpace:'nowrap'}}>Data;Descrizione;Conto;Conto destinazione;Tipo;Categoria;Importo;Note;Stato</div><div style={{display:'flex', gap:'12px', alignItems:'center', flexWrap:'wrap'}}><label style={{display:'inline-flex', alignItems:'center', gap:'7px', padding:'9px 14px', background:C.b1, border:'1px solid '+C.b3, borderRadius:'9px', color:C.t0, fontSize:'13px', fontWeight:'600', cursor:'pointer'}} {...hoverStyle({display:'inline-flex', alignItems:'center', gap:'7px', padding:'9px 14px', background:C.b1, border:'1px solid '+C.b3, borderRadius:'9px', color:C.t0, fontSize:'13px', fontWeight:'600', cursor:'pointer'}, {background:C.b2})}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4" /><polyline points="7 9 12 4 17 9" /><path d="M5 20h14" /></svg>
                Scegli file
                <input type="file" accept=".csv,text/csv" onChange={onImportFile} style={{display:'none'}} /></label><button onClick={onDownloadTemplate} style={{background:'none', border:'none', color:'#5b8def', fontSize:'12.5px', fontWeight:'600', cursor:'pointer', padding:'0'}}>Scarica modello</button>{(importHasFile) ? (<React.Fragment><span style={{fontSize:'12px', color:'#3ecf8e', fontWeight:'600'}}>{importFileName}</span></React.Fragment>) : null}</div><textarea value={data.text} onChange={onField} data-field="text" placeholder="01/07/2026;Spesa;Revolut;;Uscita;Spesa alimentare;42,50;;Non liquidato" rows="5" style={{width:'100%', resize:'vertical', padding:'10px 12px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'9px', fontSize:'12px', color:C.t0, fontFamily:'\'JetBrains Mono\',monospace', lineHeight:'1.5'}}></textarea></React.Fragment>) : null}{/* GROUP FORM */}{(isGroupModal) ? (<React.Fragment><label style={{display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600'}}>Nome del gruppo
              <input type="text" value={data.name} onChange={onField} data-field="name" placeholder="es. Obblighi fissi" style={{padding:'10px 12px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'9px', fontSize:'14px'}} /></label><label style={{display:'flex', alignItems:'center', gap:'8px', fontSize:'12.5px', color:C.t1, cursor:'pointer'}}><input type="checkbox" checked={!!data.fixed} onChange={onField} data-field="fixed" style={{width:'16px', height:'16px', accentColor:'#5b8def', cursor:'pointer'}} />Gruppo di spese fisse (usato nel report "Spese fisse vs variabili")</label><div style={{fontSize:'12px', color:C.t2, lineHeight:'1.5'}}>I gruppi organizzano le categorie di uscita nel budget. Rinominando un gruppo, tutte le categorie collegate vengono aggiornate.</div></React.Fragment>) : null}</div><div style={{display:'flex', gap:'10px', justifyContent:'space-between', alignItems:'center', padding:'16px 20px', borderTop:'1px solid '+C.b2}}>{(canDelete) ? (<React.Fragment><button onClick={onModalDelete} style={{padding:'9px 14px', background:'transparent', border:'1px solid '+C.delBorder, borderRadius:'9px', color:'#f0616d', fontSize:'13px', fontWeight:'600', cursor:'pointer'}} {...hoverStyle({padding:'9px 14px', background:'transparent', border:'1px solid '+C.delBorder, borderRadius:'9px', color:'#f0616d', fontSize:'13px', fontWeight:'600', cursor:'pointer'}, {background:'#f0616d', color:'#fff', borderColor:'#f0616d'})}>Elimina</button></React.Fragment>) : null}<div style={{display:'flex', gap:'10px', marginLeft:'auto'}}><button onClick={onClose} style={{padding:'9px 16px', background:C.b1, border:'1px solid '+C.b3, borderRadius:'9px', color:C.t0, fontSize:'13px', fontWeight:'600', cursor:'pointer'}} {...hoverStyle({padding:'9px 16px', background:C.b1, border:'1px solid '+C.b3, borderRadius:'9px', color:C.t0, fontSize:'13px', fontWeight:'600', cursor:'pointer'}, {background:C.b2})}>Annulla</button><button onClick={onSave} style={{padding:'9px 18px', background:'#5b8def', border:'none', borderRadius:'9px', color:'#fff', fontSize:'13px', fontWeight:'600', cursor:'pointer'}} {...hoverStyle({padding:'9px 18px', background:'#5b8def', border:'none', borderRadius:'9px', color:'#fff', fontSize:'13px', fontWeight:'600', cursor:'pointer'}, {background:'#6f9bf2'})}>{saveLabel}</button></div></div></div></div></React.Fragment>) : null}</div></React.Fragment>
    );
  }
}

export default App;
