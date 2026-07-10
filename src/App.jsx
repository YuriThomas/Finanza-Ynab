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
    this.store = null;
    this._supabaseUser = null;
    this.state = {
      view: startView,
      month: localTodayIso().slice(0, 7),
      isMobile: isMobile,
      drawerOpen: false,
      collapsed: false,
      auth: { loggedIn:false, busy:false, username: rememberedUser, password:'', remember: !!rememberedUser, error:'' },
      filters: { from:'', to:'', accountId:'', categoryId:'', type:'', search:'' },
      dash: { tab:'networth', range:'6m', accountId:'', groupId:'', categoryId:'', customFrom:'', customTo:'' },
      modal: { open:false, kind:null, mode:'create', data:{} },
      accounts: [],
      transactions: [],
      categories: [],
      groups: [],
      budgets: [],
      budgetEdits: {},
      collapsedGroups: {},
      theme: 'dark',
      selectedTxnIds: {},
    };
    this.accountTypes = [
      ['Current Account','Conto corrente'],['Card','Carta'],['Deposit','Deposito'],
      ['Broker','Broker'],['Pension Fund','Fondo pensione'],['Cash','Contanti'],
      ['Crypto','Crypto'],['Other','Altro']
    ];
    this.monthNames = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
    this.monthAbbrArr = ['Gen','Feb','Mar','Apr','Mag','Giu','Lug','Ago','Set','Ott','Nov','Dic'];
    this.budgetInputRefs = {};
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
  }
  componentWillUnmount(){
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('focusin', this._onBudgetFocus);
    window.removeEventListener('keydown', this._onKey);
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
      { id:'cat_casa', name:'Casa e affitto', type:'Expense', group:'Obblighi fissi', target:850 },
      { id:'cat_boll', name:'Bollette', type:'Expense', group:'Obblighi fissi', target:140 },
      { id:'cat_alim', name:'Spesa alimentare', type:'Expense', group:'Spese quotidiane', target:350 },
      { id:'cat_trasp', name:'Trasporti', type:'Expense', group:'Spese quotidiane', target:120 },
      { id:'cat_rist', name:'Ristoranti', type:'Expense', group:'Qualità della vita', target:100 },
      { id:'cat_svago', name:'Svago', type:'Expense', group:'Qualità della vita', target:80 },
      { id:'cat_shop', name:'Shopping', type:'Expense', group:'Qualità della vita', target:100 },
      { id:'cat_abb', name:'Abbonamenti', type:'Expense', group:'Abbonamenti & Salute', target:40 },
      { id:'cat_salute', name:'Salute', type:'Expense', group:'Abbonamenti & Salute', target:60 },
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
    return { Accounts:A, Transactions:T, Categories:C, Groups:G, Budgets:B, Settings:S };
  }

  refresh(){
    const s = this.store;
    this.setState({ accounts:s.all('Accounts'), transactions:s.all('Transactions'), categories:s.all('Categories'), groups:s.all('Groups'), budgets:s.all('Budgets') });
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
  // Palette centralizzata: tutti gli sfondi/bordi/testi neutri passano da qui, così il
  // tema chiaro è una vera tavolozza disegnata, non un filtro CSS applicato a forza.
  // I colori "di significato" (blu accento, verde, rosso, ambra, viola, palette grafici)
  // restano identici nei due temi: sono informativi, non di sfondo.
  getPalette(theme){
    if(theme==='light'){
      return {
        bg0:'#f5f6f8', bg1:'#eef0f3', bg2:'#ffffff', bg3:'#e2e5ea',
        b0:'#e9ebee', b1:'#e3e6ea', b2:'#d8dce2', b3:'#cfd3da', b4:'#b9bfc8',
        barEmpty:'#d3d7dd', delBorder:'#f5d0d2',
        t0:'#14161a', t1:'#5a5f68', t2:'#767c86', t3:'#8b9099', t4:'#6b7079', t5:'#8b909a', t6:'#3a3f47',
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
  newGroup(){ this.openModal('group','create',{ name:'' }); }
  editGroup(name){ const g=this.state.groups.find(x=>x.name===name); this.openModal('group','edit',{ id:g?g.id:'', name:name, origName:name }); }
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
        if(d.id) this.store.update('Groups', d.id, { name });
        this.state.categories.filter(c=>(c.group||'')===d.origName).forEach(c=>this.store.update('Categories', c.id, { group:name }));
      } else if(!this.state.groups.some(g=>g.name===name)){
        this.store.create('Groups', { name });
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
      const payload = { name:d.name.trim(), type:d.type, group:grp, target:this.parseNum(d.target) };
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
  openMoveMoney(categoryId){ this.openModal('move','create',{ fromCategoryId:categoryId, toCategoryId:'', amount:'' }); }
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
    const n = ({ '3m':3, '6m':6, '12m':12 })[range] || 6;
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
    const expenseCatList = st.categories.filter(c=>c.type==='Expense');
    let totalAssigned = 0;
    let totalAvail = 0;
    const buildBudgetRow = (c) => {
      const assigned = budgetMap[c.id] || 0; totalAssigned += assigned;
      const spent = monthTxns.filter(t=>t.type==='Expense' && t.categoryId===c.id).reduce((s,t)=>s+this.parseNum(t.amount),0);
      const carry = this.catCarryover(c.id, st.month);
      const avail = carry + assigned - spent;
      totalAvail += avail;
      const target = this.parseNum(c.target);
      const pct = target>0 ? Math.min(100,(assigned/target)*100) : (assigned>0 ? Math.min(100,(spent/assigned)*100) : (spent>0?100:0));
      const over = avail < -0.005;
      const availColor = over ? P.red : (avail<0.005 ? P.muted : P.green);
      const funded = target>0 && assigned+0.005>=target;
      const barColor = over ? P.red : (target>0 ? (funded?P.green:P.accent) : (assigned===0?C.barEmpty:P.accent));
      const totalForMonth = carry + assigned;
      const fullySpent = Math.abs(avail) < 0.005 && totalForMonth > 0.005;
      let hint='';
      if(fullySpent){ hint = 'Speso tutto'; }
      else if(target>0){
        const need=target-assigned;
        hint = need>0.005 ? ('Obiettivo '+this.fmtEur(target)+' · mancano '+this.fmtEur(need)) : ('Finanziato · speso '+this.fmtEur(spent)+' di '+this.fmtEur(totalForMonth));
      } else if(totalForMonth>0.005){ hint = 'Speso '+this.fmtEur(spent)+' di '+this.fmtEur(totalForMonth); }
      const showFundedCheck = funded && !over;
      const availPillStyle = { display:'inline-flex', alignItems:'center', gap:'4px', padding: Math.abs(avail)>0.005 ? '3px 9px' : '0', borderRadius:'999px', fontFamily:"'JetBrains Mono',monospace", fontWeight:600, fontSize:'12.5px', background: over?'rgba(240,97,109,0.12)':(avail>0.005?'rgba(62,207,142,0.12)':'transparent'), color:availColor };
      return { id:c.id, name:c.name, hint, hasHint:!!hint, hintStyle:{ fontSize:'11.5px', color:(target>0&&!funded)?'#e2b341':C.t3, marginTop:'3px' }, assigned, spent, avail, assignedValue: st.budgetEdits.hasOwnProperty(c.id) ? st.budgetEdits[c.id] : (assigned ? assigned.toFixed(2).replace('.',',') : ''), spentText:this.fmtEur(spent), availText:this.fmtEur(avail), availStyle:{ fontFamily:"'JetBrains Mono',monospace", fontWeight:600, fontSize:'13px', color:availColor }, availPillStyle, showFundedCheck, barStyle:{ height:'100%', width:pct+'%', background:barColor, borderRadius:'4px', transition:'width .3s' }, assignedRef:(el)=>{ this.budgetInputRefs[c.id]=el; }, onAssign:(e)=>this.onAssignInput(c.id,e), onAssignBlur:(e)=>this.onAssignBlur(c.id,e), onAssignFocus:(e)=>e.currentTarget.select(), onAssignKeyDown:(e)=>this.onBudgetCellKeyDown(c.id,e), onMove:()=>this.openMoveMoney(c.id) };
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
    const dashRangeBtns = [['3m','3M'],['6m','6M'],['12m','1A'],['ytd','YTD'],['all','Tutto'],['custom','Personalizzato']].map(x => ({
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
      { label: dAcc?'Saldo conto':'Patrimonio netto', value:this.fmtEur(netWorthNow), sub:'ad oggi', valColor: netWorthNow<0?P.red:P.text },
      { label:'Entrate', value:this.fmtEur(periodIncome), sub:'nel periodo', valColor:P.green },
      { label:'Uscite', value:this.fmtEur(periodExpense), sub:'nel periodo', valColor:P.red },
      { label:'Risparmio netto', value:this.fmtEur(periodNet), sub: (periodNet>=0?'tasso ':'deficit ') + Math.abs(savingsRate) + '%', valColor: periodNet>=0?P.green:P.red },
      { label:'Età del denaro', value: aom==null?'—':(aom+' gg'), sub:'copertura spese', valColor:'#8b7cf6' },
    ].map(k => Object.assign({}, k, { valStyle:{ fontFamily:"'JetBrains Mono',monospace", fontWeight:600, fontSize:'21px', marginTop:'6px', color:k.valColor } }));

    // -- Sottopagine Dashboard (una per ogni KPI/report, navigabili dal menu laterale) --
    const dashTabDefs = [
      ['networth','Patrimonio netto'], ['incomeexpense','Entrate vs Uscite'],
      ['spending','Spese per categoria'], ['incomebreakdown','Entrate per fonte'],
      ['savings','Risparmio & Età del denaro']
    ];
    const dashSubNavItem = (active) => ({ display:'flex', alignItems:'center', width:'100%', padding:'7px 10px', border:'none', borderRadius:'7px', fontSize:'12.5px', fontWeight: active?600:500, cursor:'pointer', textAlign:'left', background: active?'rgba(91,141,239,0.12)':'transparent', color: active?C.chipBlue:C.t2, transition:'background .12s' });
    const dashSideItems = dashTabDefs.map(x => ({
      key:x[0], label:x[1], onClick:()=>this.goDashTab(x[0]),
      style: dashSubNavItem(st.view==='dashboard' && dash.tab===x[0])
    }));
    const isDashNetWorth = dash.tab==='networth';
    const isDashSpending = dash.tab==='spending';
    const isDashIncomeExpense = dash.tab==='incomeexpense';
    const isDashIncomeBreakdown = dash.tab==='incomebreakdown';
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
      currentText: this.fmtEur(nwEnd), startLabel: this.monthAbbr(dFromMo), endLabel: this.monthAbbr(dToMo),
      changeText: (nwChange>=0?'+':'−') + this.fmtEur(Math.abs(nwChange)),
      changeStyle: { fontFamily:"'JetBrains Mono',monospace", fontWeight:700, fontSize:'16px', marginTop:'4px', color: nwChange>=0?P.green:P.red }
    };
    const allocColors = { 'Current Account':'#5b8def','Card':'#8b7cf6','Deposit':'#3ecf8e','Broker':'#e2b341','Pension Fund':'#4bb6c9','Cash':C.t1,'Crypto':'#e08a4b','Other':C.t5 };
    const allocMap={}; st.accounts.forEach(a=>{ const bal=this.accountBalance(a); if(bal>0) allocMap[a.type]=(allocMap[a.type]||0)+bal; });
    const allocKeys = Object.keys(allocMap);
    const allocHasData = allocKeys.length > 0;
    const allocTotal = allocKeys.reduce((s,k)=>s+allocMap[k],0);
    let allocCum=0;
    const allocSegs=allocKeys.sort((a,b)=>allocMap[b]-allocMap[a]).map(k=>{ const val=allocMap[k]; const pv=allocTotal ? (val/allocTotal)*100 : 0; const seg={ type:k, label:this.typeLabelAcc(k), color:allocColors[k]||C.t5, dotStyle:{ width:'9px', height:'9px', borderRadius:'2px', background:allocColors[k]||C.t5, flexShrink:0 }, valueText:this.fmtEur(val), pctText:Math.round(pv)+'%', dash:pv.toFixed(2)+' '+(100-pv).toFixed(2), offset:(25-allocCum).toFixed(2) }; allocCum+=pv; return seg; });
    const allocTotalText=this.fmtEur(allocTotal);

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
    const ieSummary = [
      { label:'Entrate totali', value:this.fmtEur(periodIncome), color:P.green },
      { label:'Uscite totali', value:this.fmtEur(periodExpense), color:P.red },
      { label:'Risparmio netto', value:this.fmtEur(periodNet), color: periodNet>=0?P.green:P.red },
      { label:'Tasso di risparmio', value: savingsRate+'%', color: savingsRate>=0?P.green:P.red },
    ].map(k => Object.assign({}, k, { valStyle:{ fontFamily:"'JetBrains Mono',monospace", fontWeight:600, fontSize:'19px', marginTop:'5px', color:k.color } }));
    const ieMonthRates = ieRaw.map(b => b.income>0 ? ((b.income-b.expense)/b.income)*100 : null).filter(v=>v!==null);
    const ieAvgRate = ieMonthRates.length ? Math.round(ieMonthRates.reduce((s,r)=>s+r,0)/ieMonthRates.length) : 0;
    const ieInsight = periodIncome<=0 ? '' :
      ieAvgRate < 0 ? 'In media, in questo periodo spendi più di quanto guadagni.' :
      ieAvgRate < 10 ? 'Il margine di risparmio è ridotto: in media accantoni solo il ' + ieAvgRate + '% delle entrate.' :
      'In media risparmi il ' + ieAvgRate + '% delle entrate ogni mese.';

    // ---- Scheda: Entrate per fonte (entrate suddivise per categoria) ----
    const incTxns = st.transactions.filter(t => t.type==='Income' && dInPeriod(t.date) && (!dAcc || t.accountId===dAcc));
    const byIncCat = {}; incTxns.forEach(t => { const k=t.categoryId||'__none__'; byIncCat[k]=(byIncCat[k]||0)+this.parseNum(t.amount); });
    const incTotal = Object.keys(byIncCat).reduce((s,k)=>s+byIncCat[k],0);
    const incArr = Object.keys(byIncCat).map(k=>({ cid:k, amount:byIncCat[k] })).sort((a,b)=>b.amount-a.amount);
    const maxIncCat = Math.max(1, ...incArr.map(c=>c.amount));
    let incCum=0;
    const incomeSegs = incArr.map((c,i) => { const pv = incTotal>0?(c.amount/incTotal)*100:0; const seg={ dash:pv.toFixed(2)+' '+(100-pv).toFixed(2), offset:(25-incCum).toFixed(2), color: spendPalette[i%spendPalette.length] }; incCum+=pv; return seg; });
    const incomeRows = incArr.map((c,i) => ({
      name: c.cid==='__none__' ? 'Senza categoria' : (catMap[c.cid]?catMap[c.cid].name:'Senza categoria'),
      amountText: this.fmtEur(c.amount),
      pctText: incTotal>0 ? Math.round((c.amount/incTotal)*100)+'%' : '0%',
      dotStyle:{ width:'9px', height:'9px', borderRadius:'2px', background: spendPalette[i%spendPalette.length], flexShrink:0 },
      barStyle:{ width: Math.max(2,(c.amount/maxIncCat)*100)+'%', height:'100%', background: spendPalette[i%spendPalette.length], borderRadius:'6px', transition:'width .3s' },
      onClick: c.cid==='__none__' ? ()=>{} : ()=>this.drillCategory(c.cid, dFromMo, dToMo, 'Income')
    }));
    const incomeTotalText = this.fmtEur(incTotal);
    const incomeBreakdownEmpty = incArr.length===0;

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
      { label:'Età del denaro', value: aom==null?'—':(aom+' giorni'), color:'#8b7cf6' },
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
      return { id:a.id, name:a.name, bank:a.bank, typeLabel:this.typeLabelAcc(a.type), balanceText:this.fmtEur(bal), initialText:this.fmtEur(a.initialBalance), balanceStyle:{ fontFamily:"'JetBrains Mono',monospace", fontWeight:600, fontSize:'23px', marginTop:'3px', color: bal<0?P.red:P.text }, typeBadgeStyle:{ fontSize:'11px', fontWeight:600, padding:'3px 9px', borderRadius:'6px', background:'rgba(255,255,255,0.04)', color:col, border:'1px solid '+col+'33' }, budgetBadgeLabel: onB?'Nel budget':'Tracking', budgetBadgeStyle:{ fontSize:'11px', fontWeight:600, padding:'3px 9px', borderRadius:'6px', background: onB?'rgba(62,207,142,0.1)':'rgba(146,151,161,0.1)', color: onB?'#3ecf8e':C.t1, border:'1px solid '+(onB?'rgba(62,207,142,0.25)':'rgba(146,151,161,0.22)') }, showTxnBadgeLabel: shown?'Nuovi movimenti':'Nascosto dai nuovi', showTxnBadgeStyle:{ fontSize:'11px', fontWeight:600, padding:'3px 9px', borderRadius:'6px', background: shown?'rgba(91,141,239,0.1)':'rgba(240,97,109,0.08)', color: shown?C.chipBlue:'#f0616d', border:'1px solid '+(shown?'rgba(91,141,239,0.25)':'rgba(240,97,109,0.22)') }, moveUpDisabled: idx===0, moveDownDisabled: idx===st.accounts.length-1, moveBtnStyle:{ width:'28px', height:'28px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'7px', color:C.t2, cursor:'pointer' }, onMoveUp:()=>this.moveAccount(a.id,-1), onMoveDown:()=>this.moveAccount(a.id,1), onEdit:()=>this.editAccount(a), onDelete:()=>this.delAccount(a) };
    });

    // CATEGORIES
    const incomeCats = st.categories.filter(c=>c.type==='Income').map(c=>({ id:c.id, name:c.name, onEdit:()=>this.editCategory(c), onDelete:()=>this.delCategory(c) }));
    const groupNamesCat = this.expenseGroupOrder();
    const expenseGroups = groupNamesCat.map(g=>({
      name: g||'Senza gruppo', isReal: !!g,
      cats: st.categories.filter(c=>c.type==='Expense' && (c.group||'')===g).map(c=>({ id:c.id, name:c.name, targetText: c.target? ('Obiettivo '+this.fmtEur(c.target)):'', hasTarget:!!(c.target), onEdit:()=>this.editCategory(c), onDelete:()=>this.delCategory(c) })),
      onEditGroup: g ? (()=>this.editGroup(g)) : (()=>{}),
      onDeleteGroup: g ? (()=>this.delGroup(g)) : (()=>{})
    })).map(gr=>Object.assign(gr,{ isEmptyReal: gr.isReal && gr.cats.length===0 })).filter(gr => !(gr.cats.length===0 && !gr.isReal));
    const existingGroups = st.groups.map(x=>x.name);

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

    return {
      // layout
      sidebarStyle, navStyle, isMobile:st.isMobile, showScrim: st.isMobile && st.drawerOpen,
      isLight, C, rootBg:C.bg0, rootText:C.t0, onToggleTheme:()=>this.toggleTheme(),
      toggleDrawer:()=>this.setState({ drawerOpen:!st.drawerOpen }), closeDrawer:()=>this.setState({ drawerOpen:false }),
      onMenu:()=> st.isMobile ? this.setState({ drawerOpen:!st.drawerOpen }) : this.setState({ collapsed:!st.collapsed }),
      menuTitle: st.isMobile ? 'Apri menu' : (st.collapsed ? 'Espandi barra laterale' : 'Comprimi barra laterale'),
      goBudget:()=>this.go('budget'), goTransactions:()=>this.go('transactions'), goAccounts:()=>this.go('accounts'), goCategories:()=>this.go('categories'),
      netWorthStyle, totalNetWorthText:this.fmtEur(netWorth), accountsCountText: st.accounts.length + ' cont' + (st.accounts.length===1?'o':'i'),
      onLogout:()=>this.logout(),
      navTitle, navSubtitle, primaryLabel, onPrimary,
      isBudget:st.view==='budget', isTransactions:st.view==='transactions', isAccounts:st.view==='accounts', isCategories:st.view==='categories',
      isDashboard:st.view==='dashboard', goDashboard:()=>this.go('dashboard'),
      // dashboard / report (unificati)
      dashRangeBtns, dashPeriodLabel, dashAccountOptions, dashAccountId:dash.accountId, onDashAccount:(e)=>this.setDashAccount(e),
      dashCustomOpen, dashCustomFrom, dashCustomTo, onDashCustomFrom, onDashCustomTo,
      dashSideItems, isDashNetWorth, isDashSpending, isDashIncomeExpense, isDashIncomeBreakdown, isDashSavings,
      kpis, nwTrend, allocSegs, allocTotalText, allocHasData,
      spendCats, spendSegs, spendEmpty, spendTotalText,
      dashGroupOptions, dashCategoryOptions, dashGroupId:dash.groupId, dashCategoryId:dash.categoryId, onDashGroup:(e)=>this.setDashGroup(e), onDashCategory:(e)=>this.setDashCategory(e), dashFilterActive, dashFilterLabel, clearDashFilter:()=>this.clearDashFilter(),
      ieBars, ieSummary, ieInsight,
      incomeSegs, incomeRows, incomeTotalText, incomeBreakdownEmpty,
      savRows, savSummary, savEmpty,
      // budget
      monthLabel:this.monthLabel(st.month), onPrevMonth:()=>this.setState({month:this.addMonth(st.month,-1)}), onNextMonth:()=>this.setState({month:this.addMonth(st.month,1)}), onResetBudgets:()=>this.resetBudgets(),
      readyCardStyle, readyLabel, readyText, readyWarning, readyZero, readySubtext, budgetGroups, budgetEmpty: expenseCatList.length===0,
      // transactions
      filters:st.filters, onFilter:(e)=>this.onFilterChange(e), clearFilters:()=>this.clearFilters(), hasFilters,
      accountFilterOptions, categoryFilterOptions, txnRows, txnEmpty: txnRows.length===0, emptyFilterSuffix: hasFilters?' con questi filtri':'',
      selectedTxnCount, hasTxnSelection, allTxnSelected, onToggleSelectAllTxns, onDeleteSelectedTxns, onClearTxnSelection,
      onExportCsv:()=>this.exportCsv(), onImportCsv:()=>this.openImport(),
      // accounts
      accountCards, accountsEmpty: accountCards.length===0,
      // categories
      incomeCats, expenseGroups, existingGroups, incomeEmpty:incomeCats.length===0, expenseEmpty:expenseGroups.length===0,
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
    const { username, password, remember, error, busy } = this.state.auth;
    const C = this.getPalette(this.state.theme);
    return (
      <div style={{minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:C.bg0, color:C.t0, fontFamily:"'Hanken Grotesk',system-ui,-apple-system,sans-serif", padding:'20px'}}>
        <form onSubmit={(e)=>this.submitLogin(e)} style={{width:'100%', maxWidth:'360px', background:C.bg2, border:'1px solid '+C.b1, borderRadius:'16px', padding:'28px'}}>
          <div style={{display:'flex', alignItems:'center', gap:'10px', marginBottom:'22px'}}>
            <div style={{width:'34px', height:'34px', borderRadius:'9px', background:'linear-gradient(140deg,#5b8def,#3d6fd6)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:'0'}}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round"><path d="M4 18V9M9 18V5M14 18v-6M19 18v-9" /></svg>
            </div>
            <div style={{lineHeight:'1.15'}}>
              <div style={{fontWeight:'700', fontSize:'16px', letterSpacing:'-0.2px'}}>Finanza Personale</div>
              <div style={{fontSize:'12px', color:C.t2}}>Accedi al cloud</div>
            </div>
          </div>
          <label style={{display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600', marginBottom:'14px'}}>
            Email
            <input type="email" autoCapitalize="none" autoCorrect="off" value={username} onChange={(e)=>this.onAuthUsername(e)} style={{padding:'10px 12px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, fontSize:'14px'}} />
          </label>
          <label style={{display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600', marginBottom:'6px'}}>
            Password
            <input type="password" value={password} onChange={(e)=>this.onAuthPassword(e)} style={{padding:'10px 12px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, fontSize:'14px'}} />
          </label>
          <label style={{display:'flex', alignItems:'center', gap:'8px', fontSize:'12.5px', color:C.t1, margin:'14px 0 6px', cursor:'pointer'}}>
            <input type="checkbox" checked={remember} onChange={(e)=>this.onAuthRemember(e)} style={{width:'15px', height:'15px', accentColor:'#5b8def'}} />
            Ricorda il nome utente su questo dispositivo
          </label>
          {error ? (<div style={{marginTop:'10px', padding:'9px 12px', background:'rgba(240,97,109,0.1)', border:'1px solid rgba(240,97,109,0.3)', borderRadius:'9px', color:'#f0616d', fontSize:'12.5px', fontWeight:'600'}}>{error}</div>) : null}
          <button type="submit" disabled={busy} style={{width:'100%', marginTop:'18px', padding:'11px', background: busy ? '#3d6fd6' : '#5b8def', border:'none', borderRadius:'9px', color:'#fff', fontSize:'14px', fontWeight:'700', cursor: busy ? 'default' : 'pointer'}}>{busy ? 'Accesso in corso…' : 'Accedi'}</button>
          <p style={{margin:'16px 0 0', fontSize:'11px', color:C.t3, lineHeight:'1.5'}}>I dati sono salvati nel tuo account Supabase e sincronizzati tra i dispositivi dopo il login.</p>
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
      toggleDrawer,
      closeDrawer,
      onMenu,
      menuTitle,
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
      isDashNetWorth,
      isDashSpending,
      isDashIncomeExpense,
      isDashIncomeBreakdown,
      isDashSavings,
      kpis,
      nwTrend,
      allocSegs,
      allocTotalText,
      allocHasData,
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
      ieSummary,
      ieInsight,
      incomeSegs,
      incomeRows,
      incomeTotalText,
      incomeBreakdownEmpty,
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
<div style={{display:'flex', minHeight:'100vh', background:rootBg, color:rootText, fontFamily:'\'Hanken Grotesk\',system-ui,-apple-system,sans-serif', fontSize:'14px', WebkitFontSmoothing:'antialiased', transition:'background .15s, color .15s'}}>{(showScrim) ? (<React.Fragment><div onClick={closeDrawer} style={{position:'fixed', inset:'0', background:'rgba(0,0,0,0.55)', zIndex:'40', animation:'fpOverlay .2s ease'}}></div></React.Fragment>) : null}<aside style={sidebarStyle}><div style={{display:'flex', alignItems:'center', gap:'10px', padding:'4px 6px 20px'}}><div style={{width:'30px', height:'30px', borderRadius:'8px', background:'linear-gradient(140deg,#5b8def,#3d6fd6)', display:'flex', alignItems:'center', justifyContent:'center', boxShadow:'0 2px 10px rgba(91,141,239,0.35)'}}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round"><path d="M4 18V9M9 18V5M14 18v-6M19 18v-9" /></svg></div><div style={{lineHeight:'1.1'}}><div style={{fontWeight:'700', fontSize:'14.5px', letterSpacing:'-0.2px'}}>Finanza</div><div style={{fontSize:'11px', color:C.t2, fontWeight:'500'}}>Personale</div></div></div><nav style={{display:'flex', flexDirection:'column', gap:'2px'}}><button onClick={goDashboard} style={navStyle.dashboard}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="8" height="10" rx="1.5" /><rect x="13" y="3" width="8" height="6" rx="1.5" /><rect x="3" y="15" width="8" height="6" rx="1.5" /><rect x="13" y="11" width="8" height="10" rx="1.5" /></svg><span>Dashboard</span></button>{(isDashboard) ? (<React.Fragment><div style={{display:'flex', flexDirection:'column', gap:'1px', margin:'2px 0 6px 14px', paddingLeft:'13px', borderLeft:'1px solid '+C.b2}}>{(dashSideItems || []).map((d, dIdx) => (<React.Fragment key={dIdx}><button onClick={d.onClick} style={d.style}>{d.label}</button></React.Fragment>))}</div></React.Fragment>) : null}<button onClick={goBudget} style={navStyle.budget}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></svg><span>Budget</span></button><button onClick={goTransactions} style={navStyle.transactions}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="13" y2="17" /></svg><span>Movimenti</span></button><button onClick={goAccounts} style={navStyle.accounts}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="6" width="18" height="12" rx="2" /><line x1="3" y1="10.5" x2="21" y2="10.5" /></svg><span>Conti</span></button><button onClick={goCategories} style={navStyle.categories}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></svg><span>Categorie</span></button></nav><div style={{marginTop:'auto', paddingTop:'16px'}}><div style={{background:C.bg1, border:'1px solid '+C.b2, borderRadius:'12px', padding:'14px'}}><div style={{fontSize:'11px', color:C.t2, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.5px'}}>Patrimonio netto</div><div style={netWorthStyle}>{totalNetWorthText}</div><div style={{fontSize:'11.5px', color:C.t2, marginTop:'2px'}}>{accountsCountText}</div></div><button onClick={onToggleTheme} style={{width:'100%', marginTop:'10px', padding:'8px', background:'transparent', border:'1px solid '+C.b2, borderRadius:'9px', color:C.t2, fontSize:'12px', fontWeight:'500', cursor:'pointer'}} {...hoverStyle({width:'100%', marginTop:'10px', padding:'8px', background:'transparent', border:'1px solid '+C.b2, borderRadius:'9px', color:C.t2, fontSize:'12px', fontWeight:'500', cursor:'pointer'}, {borderColor:C.b4, color:C.t0})}>{isLight ? 'Tema scuro' : 'Tema chiaro'}</button><button onClick={onLogout} style={{width:'100%', marginTop:'8px', padding:'8px', background:'transparent', border:'1px solid '+C.b2, borderRadius:'9px', color:C.t2, fontSize:'12px', fontWeight:'500', cursor:'pointer'}} {...hoverStyle({width:'100%', marginTop:'8px', padding:'8px', background:'transparent', border:'1px solid '+C.b2, borderRadius:'9px', color:C.t2, fontSize:'12px', fontWeight:'500', cursor:'pointer'}, {borderColor:C.b4, color:C.t0})}>Esci</button></div></aside><main style={{flex:'1', minWidth:'0', display:'flex', flexDirection:'column', height:'100vh', overflow:'hidden'}}><header style={{display:'flex', alignItems:'center', gap:'14px', padding:'18px 28px', borderBottom:'1px solid '+C.b1, flexShrink:'0'}}><button onClick={onMenu} title={menuTitle} style={{width:'36px', height:'36px', flexShrink:'0', display:'flex', alignItems:'center', justifyContent:'center', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, cursor:'pointer'}} {...hoverStyle({width:'36px', height:'36px', flexShrink:'0', display:'flex', alignItems:'center', justifyContent:'center', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, cursor:'pointer'}, {borderColor:C.b4})}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="20" y2="17" /></svg></button><div style={{flex:'1', minWidth:'0'}}><h1 style={{margin:'0', fontSize:'19px', fontWeight:'700', letterSpacing:'-0.3px'}}>{navTitle}</h1><p style={{margin:'2px 0 0', fontSize:'12.5px', color:C.t2}}>{navSubtitle}</p></div><button onClick={onPrimary} style={{display:'inline-flex', alignItems:'center', gap:'7px', padding:'9px 15px', background:'#5b8def', border:'none', borderRadius:'9px', color:'#fff', fontSize:'13px', fontWeight:'600', cursor:'pointer', boxShadow:'0 1px 8px rgba(91,141,239,0.3)', whiteSpace:'nowrap'}} {...hoverStyle({display:'inline-flex', alignItems:'center', gap:'7px', padding:'9px 15px', background:'#5b8def', border:'none', borderRadius:'9px', color:'#fff', fontSize:'13px', fontWeight:'600', cursor:'pointer', boxShadow:'0 1px 8px rgba(91,141,239,0.3)', whiteSpace:'nowrap'}, {background:'#6f9bf2'})}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg><span>{primaryLabel}</span></button></header><div style={{flex:'1', overflowY:'auto', padding: isMobile ? '14px' : '28px'}}>{/* ============ DASHBOARD ============ */}{(isDashboard) ? (<React.Fragment><div style={{maxWidth:'1080px', margin:'0 auto'}}><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'14px', flexWrap:'wrap', marginBottom:'20px'}}><div style={{display:'flex', alignItems:'center', gap:'10px', flexWrap:'wrap'}}><select value={dashAccountId} onChange={onDashAccount} style={{padding:'8px 11px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, fontSize:'13px', fontWeight:'500'}}><option value="">Tutti i conti</option>{(dashAccountOptions || []).map((opt, optIdx) => (<React.Fragment key={optIdx}><option value={opt.value}>{opt.label}</option></React.Fragment>))}</select><div style={{display:'flex', gap:'2px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', padding:'3px'}}>{(dashRangeBtns || []).map((b, bIdx) => (<React.Fragment key={bIdx}><button onClick={b.onClick} style={b.style}>{b.label}</button></React.Fragment>))}</div>{(dashCustomOpen) ? (<React.Fragment><div style={{display:'flex', alignItems:'center', gap:'6px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', padding:'6px 9px'}}><input type="date" value={dashCustomFrom} onChange={onDashCustomFrom} style={{background:C.bg0, border:'1px solid '+C.b2, borderRadius:'7px', color:C.t0, fontSize:'12px', padding:'5px 7px'}} /><span style={{color:C.t3, fontSize:'12px'}}>–</span><input type="date" value={dashCustomTo} onChange={onDashCustomTo} style={{background:C.bg0, border:'1px solid '+C.b2, borderRadius:'7px', color:C.t0, fontSize:'12px', padding:'5px 7px'}} /></div></React.Fragment>) : null}</div><div style={{fontSize:'12.5px', color:C.t2, fontWeight:'500'}}>Periodo: <b style={{color:C.t1}}>{dashPeriodLabel}</b></div></div>{/* KPI: sempre visibili, coerenti con il filtro sopra */}<div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))', gap:'14px', marginBottom:'24px'}}>{(kpis || []).map((k, kIdx) => (<React.Fragment key={kIdx}><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', padding:'16px 18px'}}><div style={{fontSize:'11px', color:C.t2, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.4px'}}>{k.label}</div><div style={k.valStyle}>{k.value}</div><div style={{fontSize:'11.5px', color:C.t3, marginTop:'3px'}}>{k.sub}</div></div></React.Fragment>))}</div>{/* Scheda: Patrimonio netto */}{(isDashNetWorth) ? (<React.Fragment><div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(360px,1fr))', gap:'16px'}}><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', padding:'20px'}}><div style={{display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:'14px', flexWrap:'wrap'}}><div><div style={{fontSize:'11px', color:C.t2, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.4px'}}>Patrimonio netto</div><div style={{fontFamily:'\'JetBrains Mono\',monospace', fontWeight:'700', fontSize:'24px', marginTop:'4px'}}>{nwTrend.currentText}</div></div><div style={{textAlign:'right'}}><div style={{fontSize:'11px', color:C.t2, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.4px'}}>Variazione</div><div style={nwTrend.changeStyle}>{nwTrend.changeText}</div></div></div><div style={{position:'relative', width:'100%', height:'200px', marginTop:'14px'}}><svg viewBox="0 0 100 60" preserveAspectRatio="none" style={{width:'100%', height:'100%', display:'block'}}><path d={nwTrend.areaPath} fill="rgba(91,141,239,0.14)" /><path d={nwTrend.linePath} fill="none" stroke="#5b8def" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" /></svg>{(nwTrend.dots || []).map((d, dIdx) => (<React.Fragment key={dIdx}><div style={d.style} title={d.title}></div></React.Fragment>))}</div><div style={{display:'flex', justifyContent:'space-between', fontSize:'10.5px', color:C.t3, marginTop:'8px'}}><span>{nwTrend.startLabel}</span><span>{nwTrend.endLabel}</span></div><p style={{margin:'16px 0 0', fontSize:'12px', color:C.t3}}>Somma dei saldi di tutti i conti (attività) al netto degli eventuali saldi negativi (passività), mese per mese.</p></div><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', padding:'20px'}}><h3 style={{margin:'0 0 14px', fontSize:'14px', fontWeight:'700'}}>Composizione attuale</h3>{(!allocHasData) ? (<React.Fragment><div style={{padding:'36px', textAlign:'center', color:C.t2}}>Nessun saldo positivo da mostrare.</div></React.Fragment>) : null}<div style={{display:'flex', alignItems:'center', gap:'20px', flexWrap:'wrap'}}><div style={{position:'relative', width:'132px', height:'132px', flexShrink:'0'}}><svg viewBox="0 0 42 42" style={{width:'132px', height:'132px', transform:'rotate(-90deg)'}}><circle cx="21" cy="21" r="15.915" fill="none" stroke={C.b0} strokeWidth="5" />{(allocSegs || []).map((s, sIdx) => (<React.Fragment key={sIdx}><circle cx="21" cy="21" r="15.915" fill="none" stroke={s.color} strokeWidth="5" strokeDasharray={s.dash} strokeDashoffset={s.offset} /></React.Fragment>))}</svg><div style={{position:'absolute', inset:'0', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', textAlign:'center'}}><div style={{fontSize:'9.5px', color:C.t2, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.4px'}}>Totale</div><div style={{fontFamily:'\'JetBrains Mono\',monospace', fontWeight:'600', fontSize:'13px'}}>{allocTotalText}</div></div></div><div style={{flex:'1', minWidth:'150px', display:'flex', flexDirection:'column', gap:'9px'}}>{(allocSegs || []).map((s, sIdx) => (<React.Fragment key={sIdx}><div style={{display:'flex', alignItems:'center', gap:'9px'}}><span style={s.dotStyle}></span><span style={{flex:'1', fontSize:'12.5px', color:C.t6, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{s.label}</span><span style={{fontFamily:'\'JetBrains Mono\',monospace', fontSize:'12px', color:C.t1}}>{s.valueText}</span><span style={{fontSize:'11px', color:C.t3, width:'34px', textAlign:'right'}}>{s.pctText}</span></div></React.Fragment>))}</div></div></div></div></React.Fragment>) : null}{/* Scheda: Spese */}{(isDashSpending) ? (<React.Fragment><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', padding:'20px'}}><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'14px', flexWrap:'wrap', marginBottom:'6px'}}><h3 style={{margin:'0', fontSize:'14px', fontWeight:'700'}}>Spese per categoria</h3><div style={{display:'flex', alignItems:'center', gap:'8px', flexWrap:'wrap'}}><select value={dashGroupId} onChange={onDashGroup} style={{padding:'6px 9px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'8px', color:C.t0, fontSize:'12px', fontWeight:'500'}}><option value="">Tutti i gruppi</option>{(dashGroupOptions || []).map((opt, optIdx) => (<React.Fragment key={optIdx}><option value={opt.value}>{opt.label}</option></React.Fragment>))}</select><select value={dashCategoryId} onChange={onDashCategory} style={{padding:'6px 9px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'8px', color:C.t0, fontSize:'12px', fontWeight:'500'}}><option value="">Tutte le categorie</option>{(dashCategoryOptions || []).map((opt, optIdx) => (<React.Fragment key={optIdx}><option value={opt.value}>{opt.label}</option></React.Fragment>))}</select>{(dashFilterActive) ? (<React.Fragment><button onClick={clearDashFilter} style={{display:'inline-flex', alignItems:'center', gap:'6px', padding:'6px 10px', background:'rgba(91,141,239,0.12)', border:'1px solid rgba(91,141,239,0.35)', borderRadius:'8px', color:C.chipBlue, fontSize:'11.5px', fontWeight:'600', cursor:'pointer'}} {...hoverStyle({display:'inline-flex', alignItems:'center', gap:'6px', padding:'6px 10px', background:'rgba(91,141,239,0.12)', border:'1px solid rgba(91,141,239,0.35)', borderRadius:'8px', color:C.chipBlue, fontSize:'11.5px', fontWeight:'600', cursor:'pointer'}, {background:'rgba(91,141,239,0.2)'})}>{dashFilterLabel} ×</button></React.Fragment>) : null}</div></div><div style={{marginBottom:'20px'}}><div style={{fontSize:'11px', color:C.t2, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.4px'}}>Totale speso</div><div style={{fontFamily:'\'JetBrains Mono\',monospace', fontWeight:'700', fontSize:'28px', marginTop:'4px'}}>{spendTotalText}</div></div>{(spendEmpty) ? (<React.Fragment><div style={{padding:'40px', textAlign:'center', color:C.t2}}>Nessuna spesa nel periodo selezionato.</div></React.Fragment>) : null}<div style={{display:'flex', alignItems:'flex-start', gap:'26px', flexWrap:'wrap'}}><div style={{position:'relative', width:'150px', height:'150px', flexShrink:'0'}}><svg viewBox="0 0 42 42" style={{width:'150px', height:'150px', transform:'rotate(-90deg)'}}><circle cx="21" cy="21" r="15.915" fill="none" stroke={C.b0} strokeWidth="5" />{(spendSegs || []).map((s, sIdx) => (<React.Fragment key={sIdx}><circle cx="21" cy="21" r="15.915" fill="none" stroke={s.color} strokeWidth="5" strokeDasharray={s.dash} strokeDashoffset={s.offset} /></React.Fragment>))}</svg></div><div style={{flex:'1', minWidth:'230px', display:'flex', flexDirection:'column', gap:'2px'}}>{(spendCats || []).map((c, cIdx) => (<React.Fragment key={cIdx}><div onClick={c.onClick} style={{display:'grid', gridTemplateColumns:'16px 1fr 90px 44px', gap:'10px', alignItems:'center', padding:'9px 0', cursor:'pointer', borderBottom:'1px solid '+C.b0}} {...hoverStyle({display:'grid', gridTemplateColumns:'16px 1fr 90px 44px', gap:'10px', alignItems:'center', padding:'9px 0', cursor:'pointer', borderBottom:'1px solid '+C.b0}, {opacity:'0.82'})}><span style={c.dotStyle}></span><div style={{minWidth:'0'}}><div style={{fontSize:'13px', fontWeight:'600', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{c.name}</div><div style={{height:'4px', marginTop:'5px', background:C.b1, borderRadius:'3px', overflow:'hidden'}}><div style={c.barStyle}></div></div></div><span style={{textAlign:'right', fontFamily:'\'JetBrains Mono\',monospace', fontSize:'12.5px'}}>{c.amountText}</span><span style={{textAlign:'right', fontSize:'11px', color:C.t3}}>{c.pctText}</span></div></React.Fragment>))}</div></div></div></React.Fragment>) : null}{/* Scheda: Entrate vs Uscite */}{(isDashIncomeExpense) ? (<React.Fragment><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', padding:'20px'}}><div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))', gap:'14px', marginBottom:'20px'}}>{(ieSummary || []).map((k, kIdx) => (<React.Fragment key={kIdx}><div><div style={{fontSize:'11px', color:C.t2, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.4px'}}>{k.label}</div><div style={k.valStyle}>{k.value}</div></div></React.Fragment>))}</div><div style={{display:'flex', alignItems:'center', gap:'14px', fontSize:'11.5px', color:C.t1, marginBottom:'14px'}}><span style={{display:'inline-flex', alignItems:'center', gap:'5px'}}><span style={{width:'9px', height:'9px', borderRadius:'2px', background:'#3ecf8e'}}></span>Entrate</span><span style={{display:'inline-flex', alignItems:'center', gap:'5px'}}><span style={{width:'9px', height:'9px', borderRadius:'2px', background:'#f0616d'}}></span>Uscite</span></div><div style={{display:'flex', alignItems:'flex-end', gap:'8px', overflowX:'auto', paddingBottom:'4px'}}>{(ieBars || []).map((b, bIdx) => (<React.Fragment key={bIdx}><div onClick={b.onClick} title={b.title} style={{flex:'1', minWidth:'40px', display:'flex', flexDirection:'column', alignItems:'center', gap:'7px', cursor:'pointer'}} {...hoverStyle({flex:'1', minWidth:'40px', display:'flex', flexDirection:'column', alignItems:'center', gap:'7px', cursor:'pointer'}, {opacity:'0.82'})}><div style={{width:'100%', height:'180px', display:'flex', alignItems:'flex-end', justifyContent:'center', gap:'3px'}}><div style={b.incomeStyle}></div><div style={b.expenseStyle}></div></div><div style={{fontSize:'10.5px', color:C.t2, whiteSpace:'nowrap'}}>{b.label}</div><div style={b.netStyle}>{b.netText}</div></div></React.Fragment>))}</div><div style={{fontSize:'11px', color:C.t3, marginTop:'12px'}}>Clicca un mese per aprire i movimenti corrispondenti · il numero sotto ogni colonna è il risparmio netto del mese</div>{(ieInsight) ? (<React.Fragment><div style={{marginTop:'16px', paddingTop:'16px', borderTop:'1px solid '+C.b1, display:'flex', alignItems:'center', gap:'10px'}}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#8b7cf6" strokeWidth="1.8" style={{flexShrink:'0'}}><circle cx="12" cy="12" r="9" /><path d="M12 8v5" strokeLinecap="round" /><circle cx="12" cy="16" r="0.6" fill="#8b7cf6" /></svg><span style={{fontSize:'13px', fontWeight:'600', color:C.t6}}>{ieInsight}</span></div></React.Fragment>) : null}</div></React.Fragment>) : null}{/* Scheda: Entrate per fonte */}{(isDashIncomeBreakdown) ? (<React.Fragment><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', padding:'20px'}}><div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:'16px'}}><h3 style={{margin:'0', fontSize:'14px', fontWeight:'700'}}>Entrate per fonte</h3><span style={{fontSize:'12.5px', color:C.t1}}>Totale <b style={{fontFamily:'\'JetBrains Mono\',monospace', color:C.t0}}>{incomeTotalText}</b></span></div>{(incomeBreakdownEmpty) ? (<React.Fragment><div style={{padding:'40px', textAlign:'center', color:C.t2}}>Nessuna entrata nel periodo selezionato.</div></React.Fragment>) : null}<div style={{display:'flex', alignItems:'flex-start', gap:'26px', flexWrap:'wrap'}}><div style={{position:'relative', width:'150px', height:'150px', flexShrink:'0'}}><svg viewBox="0 0 42 42" style={{width:'150px', height:'150px', transform:'rotate(-90deg)'}}><circle cx="21" cy="21" r="15.915" fill="none" stroke={C.b0} strokeWidth="5" />{(incomeSegs || []).map((s, sIdx) => (<React.Fragment key={sIdx}><circle cx="21" cy="21" r="15.915" fill="none" stroke={s.color} strokeWidth="5" strokeDasharray={s.dash} strokeDashoffset={s.offset} /></React.Fragment>))}</svg></div><div style={{flex:'1', minWidth:'230px', display:'flex', flexDirection:'column', gap:'2px'}}>{(incomeRows || []).map((c, cIdx) => (<React.Fragment key={cIdx}><div onClick={c.onClick} style={{display:'grid', gridTemplateColumns:'16px 1fr 90px 44px', gap:'10px', alignItems:'center', padding:'9px 0', cursor:'pointer', borderBottom:'1px solid '+C.b0}} {...hoverStyle({display:'grid', gridTemplateColumns:'16px 1fr 90px 44px', gap:'10px', alignItems:'center', padding:'9px 0', cursor:'pointer', borderBottom:'1px solid '+C.b0}, {opacity:'0.82'})}><span style={c.dotStyle}></span><div style={{minWidth:'0'}}><div style={{fontSize:'13px', fontWeight:'600', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{c.name}</div><div style={{height:'4px', marginTop:'5px', background:C.b1, borderRadius:'3px', overflow:'hidden'}}><div style={c.barStyle}></div></div></div><span style={{textAlign:'right', fontFamily:'\'JetBrains Mono\',monospace', fontSize:'12.5px'}}>{c.amountText}</span><span style={{textAlign:'right', fontSize:'11px', color:C.t3}}>{c.pctText}</span></div></React.Fragment>))}</div></div></div></React.Fragment>) : null}{/* Scheda: Risparmio & Età del denaro */}{(isDashSavings) ? (<React.Fragment><div style={{display:'flex', flexDirection:'column', gap:'16px'}}><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', padding:'20px'}}><div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(170px,1fr))', gap:'14px'}}>{(savSummary || []).map((k, kIdx) => (<React.Fragment key={kIdx}><div><div style={{fontSize:'11px', color:C.t2, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.4px'}}>{k.label}</div><div style={k.valStyle}>{k.value}</div></div></React.Fragment>))}</div></div><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', padding:'20px'}}><h3 style={{margin:'0 0 14px', fontSize:'14px', fontWeight:'700'}}>Tasso di risparmio mensile</h3>{(savEmpty) ? (<React.Fragment><div style={{padding:'40px', textAlign:'center', color:C.t2}}>Nessun dato nel periodo selezionato.</div></React.Fragment>) : null}<div style={{display:'flex', flexDirection:'column', gap:'2px'}}>{(savRows || []).map((r, rIdx) => (<React.Fragment key={rIdx}><div onClick={r.onClick} style={{display:'grid', gridTemplateColumns:'48px 1fr 54px 92px', gap:'12px', alignItems:'center', padding:'8px 0', cursor:'pointer', borderBottom:'1px solid '+C.b0}} {...hoverStyle({display:'grid', gridTemplateColumns:'48px 1fr 54px 92px', gap:'12px', alignItems:'center', padding:'8px 0', cursor:'pointer', borderBottom:'1px solid '+C.b0}, {opacity:'0.82'})}><span style={{fontSize:'11.5px', color:C.t1}}>{r.label}</span><div style={{height:'8px', background:C.b0, borderRadius:'4px', overflow:'hidden'}}><div style={r.barStyle}></div></div><span style={r.rateStyle}>{r.rateText}</span><span style={{textAlign:'right', fontFamily:'\'JetBrains Mono\',monospace', fontSize:'12px', color:C.t1}}>{r.netText}</span></div></React.Fragment>))}</div><p style={{margin:'14px 0 0', fontSize:'11px', color:C.t3}}>Tasso di risparmio = (entrate − uscite) / entrate del mese. Clicca una riga per aprire i movimenti di quel mese.</p></div></div></React.Fragment>) : null}</div></React.Fragment>) : null}{/* ============ BUDGET ============ */}{(isBudget) ? (<React.Fragment><div style={{maxWidth:'940px', margin:'0 auto'}}><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'16px', flexWrap:'wrap', marginBottom:'20px'}}><div style={{display:'flex', alignItems:'center', gap:'6px'}}><button onClick={onPrevMonth} style={{width:'34px', height:'34px', display:'flex', alignItems:'center', justifyContent:'center', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, cursor:'pointer'}} {...hoverStyle({width:'34px', height:'34px', display:'flex', alignItems:'center', justifyContent:'center', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, cursor:'pointer'}, {borderColor:C.b4})}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="15 18 9 12 15 6" /></svg></button><div style={{minWidth:'150px', textAlign:'center', fontWeight:'600', fontSize:'15px'}}>{monthLabel}</div><button onClick={onNextMonth} style={{width:'34px', height:'34px', display:'flex', alignItems:'center', justifyContent:'center', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, cursor:'pointer'}} {...hoverStyle({width:'34px', height:'34px', display:'flex', alignItems:'center', justifyContent:'center', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, cursor:'pointer'}, {borderColor:C.b4})}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="9 18 15 12 9 6" /></svg></button></div><div style={readyCardStyle}><div style={{display:'flex', alignItems:'center', justifyContent:'flex-end', gap:'6px'}}>{(readyWarning) ? (<React.Fragment><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L14.71 3.86a2 2 0 0 0-3.42 0Z" /></svg></React.Fragment>) : null}{(readyZero) ? (<React.Fragment><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M8.5 12.5l2.2 2.2 5-5" /></svg></React.Fragment>) : null}<div style={{fontSize:'11px', fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.5px', opacity:'0.85'}}>{readyLabel}</div></div><div style={{fontFamily:'\'JetBrains Mono\',monospace', fontWeight:'600', fontSize:'20px', marginTop:'1px'}}>{readyText}</div>{(readyWarning) ? (<React.Fragment><div style={{fontSize:'11px', marginTop:'5px', color:C.chipRed, lineHeight:'1.4'}}>{readySubtext}</div></React.Fragment>) : null}</div></div><div style={{display:'flex', justifyContent:'flex-end', marginBottom:'10px'}}><button onClick={onResetBudgets} title="Azzera l'assegnato in tutte le categorie, in tutti i mesi. Conti, movimenti e categorie non vengono toccati." style={{background:'none', border:'none', color:C.t2, fontSize:'11.5px', fontWeight:'600', cursor:'pointer', padding:'0'}} {...hoverStyle({background:'none', border:'none', color:C.t2, fontSize:'11.5px', fontWeight:'600', cursor:'pointer', padding:'0'}, {color:'#f0616d'})}>Azzera tutte le assegnazioni</button></div><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', overflow:'hidden'}}><div style={{display:'grid', gridTemplateColumns:'minmax(0,1fr) minmax(46px,64px) minmax(40px,54px) minmax(46px,64px)', gap:'8px', padding:'12px 18px', borderBottom:'1px solid '+C.b1, fontSize:'11px', color:C.t2, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.4px'}}><div style={{overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>Categoria</div><div style={{textAlign:'right', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{isMobile ? 'Ass.' : 'Assegnato'}</div><div style={{textAlign:'right', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>Speso</div><div style={{textAlign:'right', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{isMobile ? 'Disp.' : 'Disponibile'}</div></div>{(budgetGroups || []).map((grp, grpIdx) => (<React.Fragment key={grpIdx}><div style={{display:'grid', gridTemplateColumns:'minmax(0,1fr) minmax(46px,64px) minmax(40px,54px) minmax(46px,64px)', gap:'8px', alignItems:'center', padding:'11px 18px', background:C.bg1, borderBottom:'1px solid '+C.b1}}><div onClick={grp.onToggleCollapse} style={{display:'flex', alignItems:'center', gap:'6px', cursor:'pointer', fontSize:'11px', fontWeight:'700', textTransform:'uppercase', letterSpacing:'0.5px', color:C.t4}}><svg style={grp.chevronStyle} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg><span>{grp.name}</span></div><div style={{textAlign:'right', fontFamily:'\'JetBrains Mono\',monospace', fontSize:'11.5px', color:C.t2}}>{grp.assignedText}</div><div style={{textAlign:'right', fontFamily:'\'JetBrains Mono\',monospace', fontSize:'11.5px', color:C.t2}}>{grp.spentText}</div><div style={{textAlign:'right'}}><span style={grp.availStyle}>{grp.availText}</span></div></div>{(grp.collapsed ? [] : (grp.rows || [])).map((row, rowIdx) => (<React.Fragment key={rowIdx}><div style={{display:'grid', gridTemplateColumns:'minmax(0,1fr) minmax(46px,64px) minmax(40px,54px) minmax(46px,64px)', gap:'8px', alignItems:'center', padding:'13px 18px', borderBottom:'1px solid '+C.b0}}><div style={{minWidth:'0'}}><div style={{display:'flex', alignItems:'center', gap:'6px'}}><div style={{fontWeight:'600', fontSize:'13.5px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{row.name}</div><button onClick={row.onMove} title="Sposta fondi verso un'altra categoria" style={{width:'19px', height:'19px', flexShrink:'0', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:'#5b8def', cursor:'pointer', padding:'0'}} {...hoverStyle({width:'19px', height:'19px', flexShrink:'0', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:'#5b8def', cursor:'pointer', padding:'0'}, {background:'rgba(91,141,239,0.16)'})}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 7h11M14 3l4 4-4 4" /><path d="M17 17H6M10 21l-4-4 4-4" /></svg></button></div>{(row.hasHint) ? (<React.Fragment><div style={row.hintStyle}>{row.hint}</div></React.Fragment>) : null}<div style={{height:'5px', marginTop:'7px', background:C.b1, borderRadius:'4px', overflow:'hidden'}}><div style={row.barStyle}></div></div></div><div style={{display:'flex', justifyContent:'flex-end'}}><input type="text" inputMode="decimal" placeholder="0,00" value={row.assignedValue} onChange={row.onAssign} onBlur={row.onAssignBlur} style={{width:'100%', minWidth:'0', textAlign:'right', padding:'7px 6px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'8px', color:C.t0, fontFamily:'\'JetBrains Mono\',monospace', fontSize:'13px'}} /></div><div style={{textAlign:'right', fontFamily:'\'JetBrains Mono\',monospace', fontSize:'13px', color:C.t1}}>{row.spentText}</div><div style={{textAlign:'right'}}><span style={row.availPillStyle}>{(row.showFundedCheck) ? (<React.Fragment><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg></React.Fragment>) : null}<span>{row.availText}</span></span></div></div></React.Fragment>))}</React.Fragment>))}{(budgetEmpty) ? (<React.Fragment><div style={{padding:'44px 18px', textAlign:'center', color:C.t2}}>Nessuna categoria di uscita. Creane una nella sezione Categorie.</div></React.Fragment>) : null}</div><p style={{margin:'14px 2px 0', fontSize:'12px', color:C.t3}}>Lo <b style={{color:C.t4}}>speso</b> è calcolato dai movimenti del mese; il <b style={{color:C.t4}}>disponibile</b> è assegnato − speso.</p></div></React.Fragment>) : null}{/* ============ MOVIMENTI ============ */}{(isTransactions) ? (<React.Fragment><div style={{maxWidth:'1080px', margin:'0 auto'}}><div style={{display:'flex', justifyContent:'flex-end', gap:'8px', marginBottom:'14px'}}><button onClick={onExportCsv} style={{display:'inline-flex', alignItems:'center', gap:'7px', padding:'8px 13px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, fontSize:'12.5px', fontWeight:'600', cursor:'pointer'}} {...hoverStyle({display:'inline-flex', alignItems:'center', gap:'7px', padding:'8px 13px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, fontSize:'12.5px', fontWeight:'600', cursor:'pointer'}, {borderColor:C.b4})}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><polyline points="7 11 12 16 17 11" /><path d="M5 20h14" /></svg>
            Esporta CSV
          </button><button onClick={onImportCsv} style={{display:'inline-flex', alignItems:'center', gap:'7px', padding:'8px 13px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, fontSize:'12.5px', fontWeight:'600', cursor:'pointer'}} {...hoverStyle({display:'inline-flex', alignItems:'center', gap:'7px', padding:'8px 13px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, fontSize:'12.5px', fontWeight:'600', cursor:'pointer'}, {borderColor:C.b4})}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4" /><polyline points="7 9 12 4 17 9" /><path d="M5 20h14" /></svg>
            Importa CSV
          </button></div><div style={{display:'flex', alignItems:'flex-end', gap:'12px', flexWrap:'wrap', marginBottom:'18px'}}><label style={{flex:'1 1 240px', display:'flex', flexDirection:'column', gap:'5px', fontSize:'11px', color:C.t2, fontWeight:'600'}}>Cerca<input type="search" value={filters.search||''} onChange={onFilter} data-filter="search" placeholder="Cerca..." style={{padding:'8px 10px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, fontSize:'13px', fontWeight:'500'}} /></label><label style={{display:'flex', flexDirection:'column', gap:'5px', fontSize:'11px', color:C.t2, fontWeight:'600'}}>Dal
            <input type="date" value={filters.from} onChange={onFilter} data-filter="from" style={{padding:'8px 10px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, fontSize:'13px', fontWeight:'500'}} /></label><label style={{display:'flex', flexDirection:'column', gap:'5px', fontSize:'11px', color:C.t2, fontWeight:'600'}}>Al
            <input type="date" value={filters.to} onChange={onFilter} data-filter="to" style={{padding:'8px 10px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, fontSize:'13px', fontWeight:'500'}} /></label><label style={{display:'flex', flexDirection:'column', gap:'5px', fontSize:'11px', color:C.t2, fontWeight:'600'}}>Conto
            <select value={filters.accountId} onChange={onFilter} data-filter="accountId" style={{padding:'8px 10px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, fontSize:'13px', fontWeight:'500', minWidth:'150px'}}><option value="">Tutti</option>{(accountFilterOptions || []).map((opt, optIdx) => (<React.Fragment key={optIdx}><option value={opt.value}>{opt.label}</option></React.Fragment>))}</select></label><label style={{display:'flex', flexDirection:'column', gap:'5px', fontSize:'11px', color:C.t2, fontWeight:'600'}}>Categoria
            <select value={filters.categoryId} onChange={onFilter} data-filter="categoryId" style={{padding:'8px 10px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, fontSize:'13px', fontWeight:'500', minWidth:'150px'}}><option value="">Tutte</option>{(categoryFilterOptions || []).map((opt, optIdx) => (<React.Fragment key={optIdx}><option value={opt.value}>{opt.label}</option></React.Fragment>))}</select></label><label style={{display:'flex', flexDirection:'column', gap:'5px', fontSize:'11px', color:C.t2, fontWeight:'600'}}>Tipo
            <select value={filters.type} onChange={onFilter} data-filter="type" style={{padding:'8px 10px', background:C.bg1, border:'1px solid '+C.b2, borderRadius:'9px', color:C.t0, fontSize:'13px', fontWeight:'500', minWidth:'130px'}}><option value="">Tutti</option><option value="Income">Entrata</option><option value="Expense">Uscita</option><option value="Transfer">Trasferimento</option></select></label>{(hasFilters) ? (<React.Fragment><button onClick={clearFilters} style={{padding:'8px 12px', background:'transparent', border:'1px solid '+C.b2, borderRadius:'9px', color:C.t1, fontSize:'12.5px', fontWeight:'500', cursor:'pointer', height:'35px'}} {...hoverStyle({padding:'8px 12px', background:'transparent', border:'1px solid '+C.b2, borderRadius:'9px', color:C.t1, fontSize:'12.5px', fontWeight:'500', cursor:'pointer', height:'35px'}, {borderColor:C.b4, color:C.t0})}>Azzera filtri</button></React.Fragment>) : null}</div><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'10px', marginBottom:'10px', minHeight:'32px'}}><label style={{display:'flex', alignItems:'center', gap:'8px', fontSize:'12.5px', color:C.t1, cursor:'pointer'}}><input type="checkbox" checked={allTxnSelected} onChange={onToggleSelectAllTxns} style={{width:'16px', height:'16px', accentColor:'#5b8def', cursor:'pointer'}} />Seleziona tutti</label>{(hasTxnSelection) ? (<React.Fragment><div style={{display:'flex', alignItems:'center', gap:'10px'}}><span style={{fontSize:'12.5px', color:C.chipBlue, fontWeight:'600'}}>{selectedTxnCount} selezionat{selectedTxnCount===1?'o':'i'}</span><button onClick={onDeleteSelectedTxns} style={{display:'inline-flex', alignItems:'center', gap:'6px', padding:'7px 12px', background:'rgba(240,97,109,0.12)', border:'1px solid rgba(240,97,109,0.35)', borderRadius:'8px', color:'#f0616d', fontSize:'12.5px', fontWeight:'600', cursor:'pointer'}} {...hoverStyle({display:'inline-flex', alignItems:'center', gap:'6px', padding:'7px 12px', background:'rgba(240,97,109,0.12)', border:'1px solid rgba(240,97,109,0.35)', borderRadius:'8px', color:'#f0616d', fontSize:'12.5px', fontWeight:'600', cursor:'pointer'}, {background:'#f0616d', color:'#fff'})}>Elimina selezionati</button><button onClick={onClearTxnSelection} style={{background:'none', border:'none', color:C.t2, fontSize:'12.5px', fontWeight:'600', cursor:'pointer', padding:'0'}}>Annulla</button></div></React.Fragment>) : null}</div><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', overflow:'hidden'}}>{(txnRows || []).map((t, tIdx) => (<React.Fragment key={tIdx}><div {...hoverStyle(t.rowStyle, {background: t.selected ? 'rgba(91,141,239,0.14)' : C.bg1})}><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'10px'}}><div style={{display:'flex', alignItems:'center', gap:'9px'}}><input type="checkbox" checked={t.selected} onChange={t.onToggleSelect} style={{width:'15px', height:'15px', accentColor:'#5b8def', cursor:'pointer', flexShrink:'0'}} /><span style={{fontFamily:'\'JetBrains Mono\',monospace', fontSize:'11px', color:C.t3}}>{t.dateLabel}</span></div><div style={{display:'flex', gap:'2px'}}><button onClick={t.onEdit} title="Modifica" style={{width:'25px', height:'25px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'7px', color:C.t2, cursor:'pointer', flexShrink:'0'}} {...hoverStyle({width:'25px', height:'25px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'7px', color:C.t2, cursor:'pointer', flexShrink:'0'}, {borderColor:C.b4, color:C.t0})}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg></button><button onClick={t.onDelete} title="Elimina" style={{width:'25px', height:'25px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'7px', color:C.t2, cursor:'pointer', flexShrink:'0'}} {...hoverStyle({width:'25px', height:'25px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'7px', color:C.t2, cursor:'pointer', flexShrink:'0'}, {borderColor:C.delBorder, color:'#f0616d'})}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 21 6" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /></svg></button></div></div><div style={{display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:'12px'}}><div style={{minWidth:'0', flex:'1'}}><div style={{fontWeight:'700', fontSize:'14.5px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{t.description}</div>{(t.hasSub) ? (<React.Fragment><div style={{fontSize:'11.5px', color:C.t3, marginTop:'1px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{t.subLabel}</div></React.Fragment>) : null}</div><div style={{display:'flex', alignItems:'center', gap:'6px', flexShrink:'0'}}><span title={t.clearedTitle} style={t.clearedStyle}></span><span style={t.amountStyle}>{t.amountText}</span></div></div><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'10px'}}><span style={t.tagStyle}>{t.categoryName}</span><span style={{fontSize:'11.5px', color:C.t2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', textAlign:'right'}}>{t.accountName}</span></div></div></React.Fragment>))}{(txnEmpty) ? (<React.Fragment><div style={{padding:'52px 18px', textAlign:'center', color:C.t2}}>Nessun movimento{emptyFilterSuffix}.</div></React.Fragment>) : null}</div></div></React.Fragment>) : null}{/* ============ CONTI ============ */}{(isAccounts) ? (<React.Fragment><div style={{maxWidth:'1000px', margin:'0 auto', display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))', gap:'16px'}}>{(accountCards || []).map((a, aIdx) => (<React.Fragment key={aIdx}><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', padding:'18px'}} {...hoverStyle({background:C.bg2, border:'1px solid '+C.b1, borderRadius:'14px', padding:'18px'}, {borderColor:C.b4})}><div style={{display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:'10px'}}><div style={{minWidth:'0'}}><div style={{fontWeight:'700', fontSize:'15px', letterSpacing:'-0.2px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{a.name}</div><div style={{fontSize:'12.5px', color:C.t2, marginTop:'2px'}}>{a.bank}</div></div><div style={{display:'flex', gap:'4px', flexShrink:'0'}}><button onClick={a.onMoveUp} disabled={a.moveUpDisabled} title="Sposta su" style={Object.assign({}, a.moveBtnStyle, {opacity:a.moveUpDisabled?0.35:1, cursor:a.moveUpDisabled?'default':'pointer'})}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 15 12 9 18 15" /></svg></button><button onClick={a.onMoveDown} disabled={a.moveDownDisabled} title="Sposta giu" style={Object.assign({}, a.moveBtnStyle, {opacity:a.moveDownDisabled?0.35:1, cursor:a.moveDownDisabled?'default':'pointer'})}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg></button><button onClick={a.onEdit} title="Modifica" style={{width:'28px', height:'28px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'7px', color:C.t2, cursor:'pointer'}} {...hoverStyle({width:'28px', height:'28px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'7px', color:C.t2, cursor:'pointer'}, {borderColor:C.b4, color:C.t0})}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg></button><button onClick={a.onDelete} title="Elimina" style={{width:'28px', height:'28px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'7px', color:C.t2, cursor:'pointer'}} {...hoverStyle({width:'28px', height:'28px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'7px', color:C.t2, cursor:'pointer'}, {borderColor:C.delBorder, color:'#f0616d'})}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 21 6" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /></svg></button></div></div><div style={{marginTop:'16px'}}><div style={{fontSize:'11px', color:C.t2, fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.4px'}}>Saldo attuale</div><div style={a.balanceStyle}>{a.balanceText}</div></div><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginTop:'14px', paddingTop:'14px', borderTop:'1px solid '+C.b1}}><div style={{display:'flex', gap:'6px', alignItems:'center', minWidth:'0'}}><span style={a.typeBadgeStyle}>{a.typeLabel}</span><span style={a.budgetBadgeStyle}>{a.budgetBadgeLabel}</span><span style={a.showTxnBadgeStyle}>{a.showTxnBadgeLabel}</span></div><span style={{fontSize:'11.5px', color:C.t3, whiteSpace:'nowrap'}}>iniz. {a.initialText}</span></div></div></React.Fragment>))}{(accountsEmpty) ? (<React.Fragment><div style={{gridColumn:'1/-1', padding:'52px', textAlign:'center', color:C.t2, background:C.bg2, border:'1px dashed '+C.b2, borderRadius:'14px'}}>Nessun conto. Aggiungine uno per iniziare.</div></React.Fragment>) : null}</div></React.Fragment>) : null}{/* ============ CATEGORIE ============ */}{(isCategories) ? (<React.Fragment><div style={{maxWidth:'900px', margin:'0 auto', display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(300px,1fr))', gap:'20px'}}><div><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'12px'}}><h3 style={{margin:'0', fontSize:'13px', fontWeight:'700', textTransform:'uppercase', letterSpacing:'0.5px', color:'#3ecf8e'}}>Entrate</h3><button onClick={onNewIncomeCat} style={{fontSize:'12px', color:'#5b8def', background:'none', border:'none', cursor:'pointer', fontWeight:'600'}}>+ Aggiungi</button></div><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'12px', overflow:'hidden'}}>{(incomeCats || []).map((c, cIdx) => (<React.Fragment key={cIdx}><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding:'13px 16px', borderBottom:'1px solid '+C.b0}} {...hoverStyle({display:'flex', alignItems:'center', justifyContent:'space-between', padding:'13px 16px', borderBottom:'1px solid '+C.b0}, {background:C.bg1})}><span style={{fontWeight:'600', fontSize:'13.5px'}}>{c.name}</span><div style={{display:'flex', gap:'4px'}}><button onClick={c.onEdit} style={{width:'26px', height:'26px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:C.t2, cursor:'pointer'}} {...hoverStyle({width:'26px', height:'26px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:C.t2, cursor:'pointer'}, {borderColor:C.b4, color:C.t0})}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg></button><button onClick={c.onDelete} style={{width:'26px', height:'26px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:C.t2, cursor:'pointer'}} {...hoverStyle({width:'26px', height:'26px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:C.t2, cursor:'pointer'}, {borderColor:C.delBorder, color:'#f0616d'})}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 21 6" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /></svg></button></div></div></React.Fragment>))}{(incomeEmpty) ? (<React.Fragment><div style={{padding:'24px', textAlign:'center', color:C.t2, fontSize:'13px'}}>Nessuna categoria</div></React.Fragment>) : null}</div></div><div><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'12px'}}><h3 style={{margin:'0', fontSize:'13px', fontWeight:'700', textTransform:'uppercase', letterSpacing:'0.5px', color:'#f0616d'}}>Uscite</h3><div style={{display:'flex', gap:'14px'}}><button onClick={onNewGroup} style={{fontSize:'12px', color:'#5b8def', background:'none', border:'none', cursor:'pointer', fontWeight:'600'}}>+ Gruppo</button><button onClick={onNewExpenseCat} style={{fontSize:'12px', color:'#5b8def', background:'none', border:'none', cursor:'pointer', fontWeight:'600'}}>+ Categoria</button></div></div><div style={{display:'flex', flexDirection:'column', gap:'16px'}}>{(expenseGroups || []).map((grp, grpIdx) => (<React.Fragment key={grpIdx}><div><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'7px', paddingLeft:'2px', minHeight:'22px'}}><span style={{fontSize:'11px', fontWeight:'700', textTransform:'uppercase', letterSpacing:'0.5px', color:C.t4}}>{grp.name}</span>{(grp.isReal) ? (<React.Fragment><div style={{display:'flex', gap:'4px'}}><button onClick={grp.onEditGroup} title="Rinomina gruppo" style={{width:'24px', height:'24px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:C.t2, cursor:'pointer'}} {...hoverStyle({width:'24px', height:'24px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:C.t2, cursor:'pointer'}, {borderColor:C.b4, color:C.t0})}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg></button><button onClick={grp.onDeleteGroup} title="Elimina gruppo" style={{width:'24px', height:'24px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:C.t2, cursor:'pointer'}} {...hoverStyle({width:'24px', height:'24px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:C.t2, cursor:'pointer'}, {borderColor:C.delBorder, color:'#f0616d'})}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 21 6" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /></svg></button></div></React.Fragment>) : null}</div><div style={{background:C.bg2, border:'1px solid '+C.b1, borderRadius:'12px', overflow:'hidden'}}>{(grp.cats || []).map((c, cIdx) => (<React.Fragment key={cIdx}><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 16px', borderBottom:'1px solid '+C.b0}} {...hoverStyle({display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 16px', borderBottom:'1px solid '+C.b0}, {background:C.bg1})}><div style={{minWidth:'0'}}><div style={{fontWeight:'600', fontSize:'13.5px'}}>{c.name}</div>{(c.hasTarget) ? (<React.Fragment><div style={{fontSize:'11px', color:C.t3, marginTop:'2px'}}>{c.targetText}</div></React.Fragment>) : null}</div><div style={{display:'flex', gap:'4px'}}><button onClick={c.onEdit} style={{width:'26px', height:'26px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:C.t2, cursor:'pointer'}} {...hoverStyle({width:'26px', height:'26px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:C.t2, cursor:'pointer'}, {borderColor:C.b4, color:C.t0})}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg></button><button onClick={c.onDelete} style={{width:'26px', height:'26px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:C.t2, cursor:'pointer'}} {...hoverStyle({width:'26px', height:'26px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'1px solid transparent', borderRadius:'6px', color:C.t2, cursor:'pointer'}, {borderColor:C.delBorder, color:'#f0616d'})}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 21 6" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /></svg></button></div></div></React.Fragment>))}{(grp.isEmptyReal) ? (<React.Fragment><div style={{padding:'14px 16px', fontSize:'12px', color:C.t3}}>Gruppo vuoto — assegna categorie modificandole.</div></React.Fragment>) : null}</div></div></React.Fragment>))}{(expenseEmpty) ? (<React.Fragment><div style={{padding:'24px', textAlign:'center', color:C.t2, fontSize:'13px', background:C.bg2, border:'1px solid '+C.b1, borderRadius:'12px'}}>Nessuna categoria</div></React.Fragment>) : null}</div></div></div></React.Fragment>) : null}</div></main>{/* ============ MODALE ============ */}{(modalOpen) ? (<React.Fragment><div style={{position:'fixed', inset:'0', zIndex:'60', display:'flex', alignItems:'center', justifyContent:'center', padding:'20px', background:'rgba(0,0,0,0.6)', animation:'fpOverlay .18s ease'}} onClick={onBackdrop}><div style={{width:'100%', maxWidth:'460px', maxHeight:'90vh', overflowY:'auto', background:C.bg2, border:'1px solid '+C.b3, borderRadius:'16px', boxShadow:'0 24px 60px rgba(0,0,0,0.55)', animation:'fpFade .22s cubic-bezier(.2,.8,.3,1)'}} data-modal-card="1"><div style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding:'18px 20px', borderBottom:'1px solid '+C.b2}}><h2 style={{margin:'0', fontSize:'16px', fontWeight:'700'}}>{modalTitle}</h2><button onClick={onClose} style={{width:'30px', height:'30px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'none', borderRadius:'8px', color:C.t2, cursor:'pointer', fontSize:'20px'}} {...hoverStyle({width:'30px', height:'30px', display:'flex', alignItems:'center', justifyContent:'center', background:'transparent', border:'none', borderRadius:'8px', color:C.t2, cursor:'pointer', fontSize:'20px'}, {color:C.t0})}>×</button></div><div style={{padding:'20px', display:'flex', flexDirection:'column', gap:'15px'}}>{/* ACCOUNT FORM */}{(isAccountModal) ? (<React.Fragment><label style={{display:'flex', flexDirection:'column', gap:'6px', fontSize:'12px', color:C.t1, fontWeight:'600'}}>Nome
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
              <input type="text" value={data.name} onChange={onField} data-field="name" placeholder="es. Obblighi fissi" style={{padding:'10px 12px', background:C.bg0, border:'1px solid '+C.b2, borderRadius:'9px', fontSize:'14px'}} /></label><div style={{fontSize:'12px', color:C.t2, lineHeight:'1.5'}}>I gruppi organizzano le categorie di uscita nel budget. Rinominando un gruppo, tutte le categorie collegate vengono aggiornate.</div></React.Fragment>) : null}</div><div style={{display:'flex', gap:'10px', justifyContent:'space-between', alignItems:'center', padding:'16px 20px', borderTop:'1px solid '+C.b2}}>{(canDelete) ? (<React.Fragment><button onClick={onModalDelete} style={{padding:'9px 14px', background:'transparent', border:'1px solid '+C.delBorder, borderRadius:'9px', color:'#f0616d', fontSize:'13px', fontWeight:'600', cursor:'pointer'}} {...hoverStyle({padding:'9px 14px', background:'transparent', border:'1px solid '+C.delBorder, borderRadius:'9px', color:'#f0616d', fontSize:'13px', fontWeight:'600', cursor:'pointer'}, {background:'#f0616d', color:'#fff', borderColor:'#f0616d'})}>Elimina</button></React.Fragment>) : null}<div style={{display:'flex', gap:'10px', marginLeft:'auto'}}><button onClick={onClose} style={{padding:'9px 16px', background:C.b1, border:'1px solid '+C.b3, borderRadius:'9px', color:C.t0, fontSize:'13px', fontWeight:'600', cursor:'pointer'}} {...hoverStyle({padding:'9px 16px', background:C.b1, border:'1px solid '+C.b3, borderRadius:'9px', color:C.t0, fontSize:'13px', fontWeight:'600', cursor:'pointer'}, {background:C.b2})}>Annulla</button><button onClick={onSave} style={{padding:'9px 18px', background:'#5b8def', border:'none', borderRadius:'9px', color:'#fff', fontSize:'13px', fontWeight:'600', cursor:'pointer'}} {...hoverStyle({padding:'9px 18px', background:'#5b8def', border:'none', borderRadius:'9px', color:'#fff', fontSize:'13px', fontWeight:'600', cursor:'pointer'}, {background:'#6f9bf2'})}>{saveLabel}</button></div></div></div></div></React.Fragment>) : null}</div>
    );
  }
}

export default App;
