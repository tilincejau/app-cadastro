/* ================================================================
   LINCE DISTRIBUIDORA – App Cadastral (conferência de telefone/e-mail)
   Funciona offline: toda ação é gravada primeiro no aparelho (fila)
   e enviada à planilha quando houver internet. Nada se perde.
   ================================================================ */
'use strict';

const C = window.CONFIG;
const DIAS = { 1: 'Segunda', 2: 'Terça', 3: 'Quarta', 4: 'Quinta', 5: 'Sexta' };
const DIAS_C = { 1: 'Seg', 2: 'Ter', 3: 'Qua', 4: 'Qui', 5: 'Sex' };
const CAMPOS_FONE = ['Fone(1)', 'Fone(2)', 'Cel(1)', 'Cel(2)'];
const ST = {
  PENDENTE: 'PENDENTE', CONFIRMADO: 'CONFIRMADO', RECUSADO: 'RECUSADO',
  FIXO: 'FIXO CONFERIDO', INVALIDO: 'INVALIDO'
};
const ST_INFO = {
  PENDENTE: ['Aguardando confirmação', 'ouro'],
  CONFIRMADO: ['Confirmado', 'verde'],
  RECUSADO: ['Dono recusou', 'verm'],
  'FIXO CONFERIDO': ['Fixo conferido', 'verde'],
  INVALIDO: ['Inválido', 'cinza']
};
const RESOLVIDO = new Set([ST.CONFIRMADO, ST.RECUSADO, ST.FIXO, ST.INVALIDO]);
const AGUARDA = new Set([ST.PENDENTE]);
const SIT = {
  NI: ['Não iniciado', 'cinza'], EA: ['Em andamento', 'azul'],
  AG: ['Aguardando', 'ouro'], OK: ['Concluído', 'verde']
};

/* ---------- armazenamento local ---------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
  del(k) { localStorage.removeItem(k); }
};
const fila = {
  ler() { return LS.get('fila', []); },
  gravar(f) { LS.set('fila', f); },
  add(item) { const f = this.ler(); f.push(item); this.gravar(f); }
};

/* ---------- estado ---------- */
const S = {
  sess: LS.get('sessao', null),
  clientes: [], registros: [], dadosEm: 0,
  porCli: new Map(), extras: {},
  view: 'lista', aba: 'clientes', cli: null,
  f: { dia: '', rota: '', sit: '', vend: '', mesa: '', q: '' },
  pf: { u: '', st: '' },
  limite: 120, syncing: false, erro: '', ultimaSync: LS.get('ultimaSync', 0)
};

/* ---------- utilidades ---------- */
const $ = (s, el) => (el || document).querySelector(s);
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function uid(n) {
  const a = new Uint8Array(n || 20); crypto.getRandomValues(a);
  return Array.from(a, b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
}
function novoId() { return Date.now().toString(36) + '-' + uid(10); }
function diaDaPasta(p) { const d = +String(p || '').replace(/\D/g, '').slice(-1); return d >= 1 && d <= 5 ? d : 0; }
function dataBR(iso) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d)) return '';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
function chip(st) { const i = ST_INFO[st] || [st || '—', 'cinza']; return `<span class="chip ${i[1]}">${esc(i[0])}</span>`; }
function toast(msg, ms) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hide');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hide'), ms || 3000);
}
async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');
}
function online() { return navigator.onLine !== false; }

async function api(body, timeoutMs) {
  if (!C.API_URL || C.API_URL.indexOf('http') !== 0) throw new Error('Configure a API_URL no arquivo config.js');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 60000);
  try {
    const r = await fetch(C.API_URL, {
      method: 'POST', body: JSON.stringify(body), redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, signal: ctrl.signal
    });
    if (!r.ok) throw new Error('Servidor respondeu ' + r.status);
    const j = await r.json();
    if (!j.ok) { const e = new Error(j.erro || 'Erro no servidor'); e.servidor = true; throw e; }
    return j;
  } finally { clearTimeout(t); }
}

/* ---------- dados locais ---------- */
function carregarDados() {
  if (!S.sess) return;
  const d = LS.get('dados_' + S.sess.usuario, null);
  if (d) { S.clientes = d.clientes || []; S.registros = d.registros || []; S.dadosEm = d.em || 0; }
  S.extras = LS.get('extras_' + S.sess.usuario, {});
  reindexar();
}
function salvarDados() {
  if (!S.sess) return;
  try {
    LS.set('dados_' + S.sess.usuario, { clientes: S.clientes, registros: S.registros, em: S.dadosEm });
  } catch (e) { toast('Memória do aparelho cheia. Os envios pendentes continuam salvos.'); }
}

function statusLocal(it) {
  if (it.acao === 'CONFERIDO') return ST.FIXO;
  if (it.acao === 'INVALIDO') return ST.INVALIDO;
  return ST.PENDENTE;
}

/** Junta registros do servidor + itens ainda na fila do aparelho */
function reindexar() {
  const m = new Map();
  const ids = new Set();
  const push = r => { if (!m.has(r.c)) m.set(r.c, []); m.get(r.c).push(r); };
  S.registros.forEach(r => { ids.add(r.id); push(r); });
  fila.ler().forEach(it => {
    if (ids.has(it.id)) return;
    push({ id: it.id, dt: it.dt, u: it.usuario, c: it.c, ct: it.ct, tp: it.tp, or: it.or, vb: it.vb, vi: it.vi, cn: it.cn, pa: it.pa, st: statusLocal(it), local: true });
  });
  m.forEach(l => l.sort((a, b) => String(b.dt).localeCompare(String(a.dt))));
  S.porCli = m;
}

function chaveReg(r) {
  if (r.tp === 'EMAIL') return 'E' + normEmail(r.vi);
  const n = normFone(r.vi, C.DDD_PADRAO);
  return 'T' + (n ? n.chave : String(r.vi).replace(/\D/g, ''));
}

function itensDoCliente(cli) {
  const regs = S.porCli.get(cli.c) || [];
  const itens = [], vistos = new Set();
  const addFone = (raw, origem, vb) => {
    const n = normFone(raw, C.DDD_PADRAO); if (!n) return;
    const k = 'T' + n.chave; if (vistos.has(k)) return; vistos.add(k);
    itens.push({ k, tp: n.tipo, valor: n.fmt, n, origem, vb });
  };
  const addEmail = (raw, origem, vb) => {
    const e = normEmail(raw); if (!e) return;
    const k = 'E' + e; if (vistos.has(k)) return; vistos.add(k);
    itens.push({ k, tp: 'EMAIL', valor: e, origem, vb });
  };
  (cli.f || []).forEach((raw, i) => addFone(raw, CAMPOS_FONE[i], raw));
  addEmail(cli.e, 'Email-NF-e', cli.e);
  (S.extras[cli.c] || []).forEach(x => x.tp === 'EMAIL' ? addEmail(x.valor, 'NOVO', '') : addFone(x.valor, 'NOVO', ''));
  regs.forEach(r => r.tp === 'EMAIL' ? addEmail(r.vi, r.or || 'NOVO', r.vb) : addFone(r.vi, r.or || 'NOVO', r.vb));
  itens.forEach(it => {
    it.regs = regs.filter(r => chaveReg(r) === it.k);
    const conf = it.regs.find(r => r.st === ST.CONFIRMADO);
    it.ult = it.regs[0] || null;
    it.st = conf ? ST.CONFIRMADO : (it.ult ? it.ult.st : '');
  });
  return itens;
}

function situacao(itens) {
  if (!itens.some(i => i.regs.length)) return 'NI';
  if (itens.some(i => AGUARDA.has(i.st))) return 'AG';
  if (itens.every(i => RESOLVIDO.has(i.st))) return 'OK';
  return 'EA';
}

function ehGerente() { return S.sess && S.sess.perfil === 'gerente'; }
function ehSupervisor() { return S.sess && (S.sess.perfil === 'supervisor' || S.sess.perfil === 'gerente'); }

/* ================================================================
   LOGIN
   ================================================================ */
function renderLogin(msg) {
  const pend = fila.ler().length;
  $('#app').innerHTML = `
  <div class="login"><div class="card">
    <img src="logo.png" alt="Lince Distribuidora">
    <div class="linha-d"></div>
    <h1>Conferência de cadastro</h1>
    <label class="lb">Usuário</label>
    <input class="in" id="lu" inputmode="numeric" autocomplete="username" value="${esc(LS.get('ultimoUsuario', ''))}">
    <label class="lb">Senha</label>
    <input class="in" id="ls" type="password" autocomplete="current-password">
    <button class="btn full" id="lb">Entrar</button>
    ${msg ? `<div class="erro">${esc(msg)}</div>` : ''}
    ${pend ? `<div class="aviso">${pend} envio(s) guardado(s) neste aparelho aguardando internet. Eles serão enviados automaticamente.</div>` : ''}
  </div></div>`;
  $('#lb').onclick = entrar;
  $('#ls').onkeydown = e => { if (e.key === 'Enter') entrar(); };
}

async function entrar() {
  const u = $('#lu').value.trim(), s = $('#ls').value.trim();
  if (!u || !s) return renderLogin('Informe usuário e senha.');
  const btn = $('#lb'); btn.disabled = true; btn.textContent = 'Entrando...';
  const hash = await sha256(u + ':' + s);
  try {
    const r = await api({ acao: 'login', usuario: u, senha: s }, 90000);
    S.sess = { usuario: r.usuario, token: r.token, perfil: r.perfil };
    LS.set('sessao', S.sess); LS.set('auth_' + u, hash); LS.set('ultimoUsuario', u);
    S.clientes = r.clientes; S.registros = r.registros; S.dadosEm = Date.now();
    // itens antigos deste usuário na fila passam a usar a sessão nova
    const f = fila.ler(); f.forEach(i => { if (i.usuario === u) i.auth = r.token; }); fila.gravar(f);
    salvarDados(); carregarDados();
    iniciarApp();
    sincronizar();
  } catch (e) {
    if (e.servidor) return renderLogin(e.message);
    // sem internet: entra com os dados salvos no aparelho
    const salvo = LS.get('auth_' + u, null), dados = LS.get('dados_' + u, null), sessAnt = LS.get('sess_' + u, null);
    if (salvo && salvo === hash && dados && sessAnt) {
      S.sess = sessAnt; LS.set('sessao', S.sess); LS.set('ultimoUsuario', u);
      carregarDados(); iniciarApp(); toast('Sem internet – usando dados salvos no aparelho');
    } else if (salvo && salvo !== hash) {
      renderLogin('Senha incorreta.');
    } else {
      renderLogin('Sem conexão. O primeiro acesso precisa de internet. (' + e.message + ')');
    }
  }
}

function sair() {
  const pend = fila.ler().filter(i => i.usuario === S.sess.usuario).length;
  if (pend && !confirm(`Há ${pend} envio(s) ainda não sincronizado(s). Eles continuam salvos e serão enviados automaticamente. Sair mesmo assim?`)) return;
  LS.del('sessao'); S.sess = null; S.clientes = []; S.registros = []; S.porCli = new Map();
  renderLogin();
}

/* ================================================================
   ESTRUTURA PRINCIPAL
   ================================================================ */
function iniciarApp() {
  LS.set('sess_' + S.sess.usuario, S.sess);
  S.view = 'lista'; S.aba = 'clientes';
  render();
}

function render() {
  if (!S.sess) return renderLogin();
  const sup = ehSupervisor();
  $('#app').innerHTML = `
  <header class="topo">
    <div class="l1">
      ${S.view === 'detalhe' ? '<button class="btn-ico" id="voltar" aria-label="Voltar">←</button>' : ''}
      <img src="logo-branca.png" alt="Lince Distribuidora">
      <div class="quem"><b>${esc(S.sess.usuario)}</b><br>${ehGerente() ? 'Gerente' : sup ? 'Supervisor' : 'Vendedor'}</div>
      <button class="btn-ico" id="bmenu" aria-label="Menu">☰</button>
    </div>
    <div class="barra-sync" id="bsync"></div>
    ${S.view !== 'detalhe' ? `<nav class="abas">
      <button data-aba="clientes" class="${S.aba === 'clientes' ? 'on' : ''}">Clientes</button>
      <button data-aba="painel" class="${S.aba === 'painel' ? 'on' : ''}">${sup ? 'Acompanhamento' : 'Meus envios'}</button>
    </nav>` : ''}
    <div class="menu hide" id="menu">
      <button data-m="sync">⟳ Sincronizar agora</button>
      <button data-m="base">⬇ Atualizar clientes da planilha</button>
      <button data-m="backup">💾 Salvar cópia dos pendentes</button>
      <button data-m="sair">⎋ Sair</button>
    </div>
  </header>
  <main id="main"></main>`;
  barra();
  if ($('#voltar')) $('#voltar').onclick = () => { S.view = 'lista'; render(); window.scrollTo(0, S.scrollLista || 0); };
  $('#bmenu').onclick = e => { e.stopPropagation(); $('#menu').classList.toggle('hide'); };
  document.onclick = () => { const m = $('#menu'); if (m) m.classList.add('hide'); };
  $('#menu').onclick = e => {
    const a = e.target.dataset.m; if (!a) return;
    if (a === 'sync') sincronizar(true);
    if (a === 'base') { S.dadosEm = 0; sincronizar(true); }
    if (a === 'backup') backup();
    if (a === 'sair') sair();
  };
  document.querySelectorAll('[data-aba]').forEach(b => b.onclick = () => { S.aba = b.dataset.aba; S.limite = 120; render(); });
  if (S.view === 'detalhe') renderDetalhe();
  else if (S.aba === 'painel') renderPainel();
  else renderLista();
}

function barra() {
  const el = $('#bsync'); if (!el) return;
  const pend = fila.ler().length;
  const on = online();
  let txt, cls = '';
  if (S.syncing) { txt = 'Sincronizando com a planilha...'; cls = 'sync'; }
  else if (!on) { txt = 'Sem internet – trabalhando offline'; cls = 'off'; }
  else if (S.erro) { txt = 'Falha ao sincronizar – nova tentativa automática'; cls = 'off'; }
  else txt = S.ultimaSync ? 'Sincronizado às ' + new Date(S.ultimaSync).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : 'Aguardando sincronização';
  el.innerHTML = `<span class="dot ${cls}"></span><span>${esc(txt)}</span>${pend ? `<span class="fila" title="Envios guardados no aparelho">${pend} na fila</span>` : ''}`;
}

/* ================================================================
   LISTA DE CLIENTES
   ================================================================ */
function clientesCalculados() {
  return S.clientes.map(c => {
    const itens = itensDoCliente(c);
    return { c, itens, sit: situacao(itens), dia: diaDaPasta(c.p) };
  });
}

function renderLista() {
  const sup = ehSupervisor();
  const todos = clientesCalculados();
  const f = S.f;
  const ger = ehGerente();
  const mesas = ger ? [...new Set(S.clientes.map(c => c.m).filter(Boolean))].sort((a, b) => a - b) : [];
  const baseMesa = todos.filter(x => !f.mesa || x.c.m === f.mesa);
  const vendedores = sup ? [...new Set(baseMesa.flatMap(x => [x.c.v1, x.c.v5]).filter(Boolean))].sort((a, b) => a - b) : [];
  if (f.vend && !vendedores.includes(f.vend)) f.vend = '';
  const baseVend = baseMesa.filter(x => !f.vend || x.c.v1 === f.vend || x.c.v5 === f.vend);
  const baseDia = baseVend.filter(x => !f.dia || String(x.dia) === f.dia);
  const rotas = [...new Set(baseDia.map(x => x.c.p).filter(Boolean))].sort((a, b) => a - b);
  if (f.rota && !rotas.includes(f.rota)) f.rota = '';
  const baseRota = baseDia.filter(x => !f.rota || x.c.p === f.rota);
  const q = f.q.trim().toLowerCase();
  const baseBusca = q ? baseRota.filter(x => (x.c.s + ' ' + x.c.r + ' ' + x.c.c + ' ' + x.c.doc + ' ' + x.c.ct).toLowerCase().includes(q)) : baseRota;
  const cont = { NI: 0, EA: 0, AG: 0, OK: 0 };
  baseBusca.forEach(x => cont[x.sit]++);
  const lista = baseBusca.filter(x => !f.sit || x.sit === f.sit);

  $('#main').innerHTML = `
  <div class="filtros">
    <div class="dias">
      <button data-dia="" class="${!f.dia ? 'on' : ''}">Todos</button>
      ${[1, 2, 3, 4, 5].map(d => `<button data-dia="${d}" class="${f.dia === String(d) ? 'on' : ''}">${DIAS_C[d]}</button>`).join('')}
    </div>
    ${ger ? `<select class="in" id="fmesa" style="grid-column:1/-1"><option value="">Todas as mesas</option>${mesas.map(m => `<option value="${esc(m)}" ${f.mesa === m ? 'selected' : ''}>Mesa ${esc(m)}</option>`).join('')}</select>` : ''}
    ${sup ? `<select class="in" id="fvend"><option value="">Todos vendedores</option>${vendedores.map(v => `<option ${f.vend === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>` : ''}
    <select class="in" id="frota" ${sup ? '' : 'style="grid-column:1/-1"'}><option value="">Todas as rotas</option>${rotas.map(r => `<option value="${esc(r)}" ${f.rota === r ? 'selected' : ''}>Rota ${esc(r)}${diaDaPasta(r) ? ' – ' + DIAS[diaDaPasta(r)] : ''}</option>`).join('')}</select>
    <input class="in busca" id="fq" placeholder="🔍 Buscar nome, código, CNPJ, contato" value="${esc(f.q)}">
  </div>
  <div class="resumo">
    <span class="chip ${!f.sit ? 'verde' : 'cinza'}" data-sit="">Todos ${baseBusca.length}</span>
    ${Object.keys(SIT).map(k => `<span class="chip ${f.sit === k ? SIT[k][1] : 'cinza'}" data-sit="${k}" style="${f.sit === k ? 'outline:2px solid currentColor' : ''}">${SIT[k][0]} ${cont[k]}</span>`).join('')}
  </div>
  <div id="lista">
    ${lista.length ? lista.slice(0, S.limite).map(cardCliente).join('') : '<div class="vazio">Nenhum cliente encontrado com esses filtros.</div>'}
    ${lista.length > S.limite ? `<button class="btn sec mais" id="mais">Mostrar mais (${lista.length - S.limite})</button>` : ''}
  </div>`;

  document.querySelectorAll('[data-dia]').forEach(b => b.onclick = () => { f.dia = b.dataset.dia; S.limite = 120; renderLista(); });
  document.querySelectorAll('[data-sit]').forEach(b => b.onclick = () => { f.sit = b.dataset.sit; S.limite = 120; renderLista(); });
  if ($('#fmesa')) $('#fmesa').onchange = e => { f.mesa = e.target.value; S.limite = 120; renderLista(); };
  if ($('#fvend')) $('#fvend').onchange = e => { f.vend = e.target.value; renderLista(); };
  $('#frota').onchange = e => { f.rota = e.target.value; renderLista(); };
  const fq = $('#fq');
  fq.oninput = () => { f.q = fq.value; clearTimeout(renderLista._t); renderLista._t = setTimeout(() => { renderLista(); const n = $('#fq'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 250); };
  if ($('#mais')) $('#mais').onclick = () => { S.limite += 200; renderLista(); };
  $('#lista').onclick = e => {
    const el = e.target.closest('[data-cli]'); if (!el) return;
    S.scrollLista = window.scrollY;
    S.cli = el.dataset.cli; S.view = 'detalhe'; render(); window.scrollTo(0, 0);
  };
}

function cardCliente(x) {
  const c = x.c, sit = SIT[x.sit];
  const nT = x.itens.filter(i => i.tp !== 'EMAIL').length, nE = x.itens.filter(i => i.tp === 'EMAIL').length;
  const nOk = x.itens.filter(i => RESOLVIDO.has(i.st)).length;
  const temLocal = (S.porCli.get(c.c) || []).some(r => r.local);
  return `<div class="cli ${x.sit}" data-cli="${esc(c.c)}">
    <div style="min-width:0">
      <div class="nm">${esc(c.s || c.r)}</div>
      <div class="sub">${esc(c.c)} · ${esc(c.r)}</div>
      <div class="sub">Rota ${esc(c.p)}${x.dia ? ' (' + DIAS_C[x.dia] + ')' : ''}${ehSupervisor() ? ' · Vend ' + esc(c.v1) + (c.v5 ? '/' + esc(c.v5) : '') : ''}${ehGerente() ? ' · Mesa ' + esc(c.m) : ''}</div>
    </div>
    <div class="dir">
      <span class="chip ${sit[1]}">${sit[0]}</span>
      <div class="ic">📞${nT} ✉️${nE} · ${nOk}/${x.itens.length} ok${temLocal ? ' <span class="nsinc">⏳</span>' : ''}</div>
    </div>
  </div>`;
}

/* ================================================================
   DETALHE DO CLIENTE
   ================================================================ */
function clienteAtual() { return S.clientes.find(c => c.c === S.cli); }

function renderDetalhe() {
  const cli = clienteAtual();
  if (!cli) { S.view = 'lista'; return render(); }
  const contatoSalvo = LS.get('contato_' + cli.c, null);
  $('#main').innerHTML = `
  <div class="det-top"><h2>${esc(cli.s || cli.r)}</h2></div>
  <div class="box">
    <div class="info">
      <b>${esc(cli.r)}</b><br>
      Código <b>${esc(cli.c)}</b> · CNPJ/CPF <b>${esc(cli.doc)}</b><br>
      Rota <b>${esc(cli.p)}</b>${diaDaPasta(cli.p) ? ' (' + DIAS[diaDaPasta(cli.p)] + ')' : ''} · Vendedor <b>${esc(cli.v1)}${cli.v5 ? ' / ' + esc(cli.v5) : ''}</b> · Mesa <b>${esc(cli.m)}</b>
    </div>
    <label class="lb">Contato (nome do responsável)</label>
    <input class="in" id="contato" value="${esc(contatoSalvo != null ? contatoSalvo : cli.ct)}">
  </div>
  <div class="box"><h3>Telefones</h3><div id="itensT"></div>
    <div class="add"><input class="in" id="novoT" type="tel" inputmode="tel" placeholder="Adicionar telefone com DDD"><button class="btn ouro" id="addT">+ Adicionar</button></div>
  </div>
  <div class="box"><h3>E-mail</h3><div id="itensE"></div>
    <div class="add"><input class="in" id="novoE" type="email" inputmode="email" placeholder="Adicionar / corrigir e-mail"><button class="btn ouro" id="addE">+ Adicionar</button></div>
  </div>`;
  $('#contato').onchange = e => LS.set('contato_' + cli.c, e.target.value.trim());
  $('#addT').onclick = () => {
    const v = $('#novoT').value; const n = normFone(v, C.DDD_PADRAO);
    if (!n || n.tipo === 'REVISAR') return toast('Telefone inválido. Use DDD + número.');
    adicionarExtra(cli, 'FONE', n.fmt); $('#novoT').value = '';
  };
  $('#addE').onclick = () => {
    const v = normEmail($('#novoE').value);
    if (!emailValido(v)) return toast('E-mail inválido.');
    adicionarExtra(cli, 'EMAIL', v); $('#novoE').value = '';
  };
  renderItens();
}

function adicionarExtra(cli, tp, valor) {
  const l = S.extras[cli.c] = S.extras[cli.c] || [];
  l.push({ tp, valor });
  LS.set('extras_' + S.sess.usuario, S.extras);
  renderItens(); toast('Adicionado. Agora envie a confirmação.');
}

function renderItens() {
  const cli = clienteAtual(); if (!cli || !$('#itensT')) return;
  const itens = itensDoCliente(cli);
  const tel = itens.filter(i => i.tp !== 'EMAIL'), em = itens.filter(i => i.tp === 'EMAIL');
  const cels = tel.filter(i => i.tp === 'CELULAR' && i.st !== ST.INVALIDO && i.st !== ST.RECUSADO);
  const emPend = em.filter(i => i.st !== ST.CONFIRMADO && i.st !== ST.INVALIDO);
  const ctx = { cels, emPend };
  $('#itensT').innerHTML = tel.length ? tel.map(i => cardItem(i, ctx)).join('') : '<div class="vazio">Nenhum telefone na base.</div>';
  $('#itensE').innerHTML = em.length ? em.map(i => cardItem(i, ctx)).join('') : '<div class="vazio">Nenhum e-mail na base.</div>';
  const handler = e => {
    const b = e.target.closest('[data-acao]'); if (!b) return;
    const it = itens.find(i => i.k === b.dataset.k); if (!it) return;
    executar(cli, it, b.dataset.acao, itens, b.closest('.item'));
  };
  $('#itensT').onclick = handler; $('#itensE').onclick = handler;
}

function cardItem(it, ctx) {
  const tipoChip = it.tp === 'CELULAR' ? '<span class="chip azul">Celular</span>' : it.tp === 'FIXO' ? '<span class="chip cinza">Fixo</span>' : it.tp === 'EMAIL' ? '<span class="chip azul">E-mail</span>' : '<span class="chip verm">Revisar número</span>';
  const jaFoi = it.regs.length > 0;
  let acoes = '';
  const k = esc(it.k);
  if (it.tp === 'CELULAR') {
    acoes = `<button class="btn zap peq" data-acao="WHATS" data-k="${k}">${jaFoi ? '↻ Reenviar' : '📲 Enviar'} WhatsApp</button>
             <button class="btn sec peq" data-acao="SMS" data-k="${k}">✉ SMS</button>`;
    if (ctx.emPend.length) acoes = `<label class="inc"><input type="checkbox" class="incE" checked><span>Confirmar também o e-mail <b>${esc(ctx.emPend.map(e => e.valor).join(', '))}</b> na mesma mensagem</span></label>` + acoes;
  } else if (it.tp === 'FIXO') {
    acoes = `<button class="btn peq" data-acao="CONFERIDO" data-k="${k}">✔ Conferido</button>`;
  } else if (it.tp === 'EMAIL') {
    if (!ctx.cels.length) acoes = `<div class="aviso" style="margin:0 0 6px">O e-mail é confirmado pelo WhatsApp do cliente. Adicione um celular em Telefones para enviar.</div>`;
    else acoes = (ctx.cels.length > 1 ? `<select class="in selCel" style="margin-bottom:6px">${ctx.cels.map(c => `<option value="${esc(c.k)}">Enviar para ${esc(c.valor)}</option>`).join('')}</select>` : '') +
      `<button class="btn zap peq" data-acao="EMAIL" data-k="${k}">${jaFoi ? '↻ Reenviar' : '📲 Enviar'} pelo WhatsApp${ctx.cels.length === 1 ? ' ' + esc(ctx.cels[0].valor) : ''}</button>`;
  }
  if (it.st !== ST.INVALIDO) acoes += `<button class="btn perigo peq" data-acao="INVALIDO" data-k="${k}">✖ Inválido</button>`;
  const hist = it.regs.slice(0, 5).map(r =>
    `<div>${dataBR(r.dt)} · ${esc(r.u)} · ${esc(r.cn || '')}${r.pa && r.tp === 'EMAIL' ? ' p/ ' + esc(r.pa) : ''} · ${esc((ST_INFO[r.st] || [r.st])[0])}${r.rs ? ' em ' + dataBR(r.rs) : ''}${r.local ? ' <span class="nsinc">⏳ não sincronizado</span>' : ''}</div>`).join('');
  return `<div class="item">
    <div class="val">${esc(it.valor)}</div>
    <div class="meta">${tipoChip}${it.st ? chip(it.st) : '<span class="chip cinza">Não enviado</span>'}<span>Origem: ${esc(it.origem)}</span></div>
    <div class="acoes">${acoes}</div>
    ${hist ? `<div class="hist">${hist}</div>` : ''}
  </div>`;
}

function mensagemConfirmacao(cli, contato, link, regs) {
  const ola = contato ? `Olá, ${contato}!` : 'Olá!';
  const tel = regs.filter(r => r.tp !== 'EMAIL').map(r => r.vi);
  const em = regs.filter(r => r.tp === 'EMAIL').map(r => r.vi);
  const partes = [];
  if (tel.length) partes.push('o telefone ' + tel.join(', '));
  if (em.length) partes.push('o e-mail ' + em.join(', '));
  return `${ola} Aqui é da ${C.EMPRESA}. Estamos atualizando o cadastro de ${cli.s || cli.r}.\n\n` +
    `Por favor, confirme ${partes.join(' e ')} tocando no link abaixo:\n${link}\n\nObrigado!`;
}

function executar(cli, it, acao, itens, card) {
  const contato = ($('#contato') && $('#contato').value.trim()) || cli.ct || '';
  const novo = (item, extra) => Object.assign({
    id: novoId(), token: '', dt: new Date().toISOString(), usuario: S.sess.usuario, auth: S.sess.token,
    c: cli.c, ct: contato, tp: item.tp === 'REVISAR' ? 'FIXO' : item.tp, or: item.origem, vb: item.vb || '', vi: item.valor,
    cn: 'NENHUM', pa: '', acao: 'ENVIO'
  }, extra || {});

  if (acao === 'CONFERIDO') { gravar([novo(it, { acao: 'CONFERIDO' })]); return toast('Telefone fixo marcado como conferido'); }
  if (acao === 'INVALIDO') {
    if (!confirm('Marcar ' + it.valor + ' como inválido?')) return;
    gravar([novo(it, { acao: 'INVALIDO' })]); return toast('Marcado como inválido');
  }

  // Envio pelo WhatsApp / SMS
  let cel, alvos;
  if (acao === 'EMAIL') {
    const sel = card && card.querySelector('.selCel');
    cel = sel ? itens.find(i => i.k === sel.value) : itens.find(i => i.tp === 'CELULAR' && i.st !== ST.INVALIDO && i.st !== ST.RECUSADO);
    if (!cel) return toast('Adicione um celular para enviar a confirmação do e-mail.');
    alvos = [it];
  } else {
    cel = it;
    alvos = [it];
    const inc = card && card.querySelector('.incE');
    if (inc && inc.checked) itens.filter(i => i.tp === 'EMAIL' && i.st !== ST.CONFIRMADO && i.st !== ST.INVALIDO).forEach(e => alvos.push(e));
  }
  const canal = acao === 'SMS' ? 'SMS' : 'WHATSAPP';
  const regs = alvos.map(a => novo(a, { token: (a.tp === 'EMAIL' ? 'e' : 'f') + uid(20), cn: canal, pa: cel.valor }));
  const link = C.API_URL + '?t=' + regs.map(r => r.token).join('-');
  const msg = encodeURIComponent(mensagemConfirmacao(cli, contato, link, regs));
  const url = canal === 'SMS' ? 'sms:+' + cel.n.intl + '?&body=' + msg : 'https://wa.me/' + cel.n.intl + '?text=' + msg;
  gravar(regs);
  abrirLink(url);
}

function gravar(regs) {
  const f = fila.ler(); regs.forEach(r => f.push(r)); fila.gravar(f);   // 1º grava no aparelho (nunca se perde)
  reindexar(); renderItens(); barra();
  setTimeout(() => sincronizar(), 300);
}

function abrirLink(url) {
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
}

/* ================================================================
   PAINEL / ACOMPANHAMENTO
   ================================================================ */
function renderPainel() {
  const sup = ehSupervisor();
  const ger = ehGerente();
  const calcTodos = clientesCalculados();
  const calc = ger && S.f.mesa ? calcTodos.filter(x => x.c.m === S.f.mesa) : calcTodos;
  const porM = {};
  if (ger) calcTodos.forEach(x => {
    const m = x.c.m || '—';
    const o = porM[m] = porM[m] || { tot: 0, ini: 0, ok: 0, ag: 0 };
    o.tot++; if (x.sit !== 'NI') o.ini++; if (x.sit === 'OK') o.ok++; if (x.sit === 'AG') o.ag++;
  });
  const codsMesa = new Set(calc.map(x => x.c.c));
  const cont = { NI: 0, EA: 0, AG: 0, OK: 0 };
  calc.forEach(x => cont[x.sit]++);
  const regs = [];
  S.porCli.forEach((l, c) => { if (!ger || !S.f.mesa || codsMesa.has(c)) l.forEach(r => regs.push(r)); });
  regs.sort((a, b) => String(b.dt).localeCompare(String(a.dt)));
  const cliPorCod = new Map(S.clientes.map(c => [c.c, c]));

  // por usuário que executou
  const porU = {};
  regs.forEach(r => {
    const o = porU[r.u] = porU[r.u] || { env: 0, conf: 0, pend: 0, rec: 0, fixo: 0, inv: 0 };
    if (r.cn && r.cn !== 'NENHUM') o.env++;
    if (r.st === ST.CONFIRMADO) o.conf++;
    else if (AGUARDA.has(r.st)) o.pend++;
    else if (r.st === ST.RECUSADO) o.rec++;
    else if (r.st === ST.FIXO) o.fixo++;
    else if (r.st === ST.INVALIDO) o.inv++;
  });
  // carteira por vendedor (supervisor)
  const porV = {};
  if (sup) calc.forEach(x => {
    const v = x.c.v1 || '—';
    const o = porV[v] = porV[v] || { tot: 0, ini: 0, ok: 0, ag: 0 };
    o.tot++; if (x.sit !== 'NI') o.ini++; if (x.sit === 'OK') o.ok++; if (x.sit === 'AG') o.ag++;
  });

  const usuarios = Object.keys(porU).sort();
  const filtrados = regs.filter(r => (!S.pf.u || r.u === S.pf.u) && (!S.pf.st || r.st === S.pf.st)).slice(0, 300);

  const tabela = (titulo, rot, mapa) => `<div class="box"><h3>${titulo}</h3><div class="scroll"><table class="tb">
    <tr><th>${rot}</th><th>Clientes</th><th>Iniciados</th><th>Aguard.</th><th>Concl.</th><th>%</th></tr>
    ${Object.keys(mapa).sort((a, b) => a - b).map(v => { const o = mapa[v]; const p = o.tot ? Math.round(o.ini / o.tot * 100) : 0; return `<tr><td><b>${esc(v)}</b></td><td>${o.tot}</td><td>${o.ini}</td><td>${o.ag}</td><td>${o.ok}</td><td><div class="barra"><i style="width:${p}%"></i></div>${p}%</td></tr>`; }).join('')}
  </table></div></div>`;
  $('#main').innerHTML = `
  ${ger ? `<select class="in" id="pmesa" style="margin-bottom:10px"><option value="">Todas as mesas</option>${Object.keys(porM).sort((a, b) => a - b).map(m => `<option value="${esc(m)}" ${S.f.mesa === m ? 'selected' : ''}>Mesa ${esc(m)}</option>`).join('')}</select>` : ''}
  <div class="cards">
    <div class="kpi"><div class="n">${calc.length}</div><div class="t">Clientes ${ger ? (S.f.mesa ? 'da mesa ' + esc(S.f.mesa) : 'no total') : sup ? 'da mesa' : 'na carteira'}</div></div>
    <div class="kpi o"><div class="n">${calc.length - cont.NI}</div><div class="t">Iniciados</div></div>
    <div class="kpi o"><div class="n">${cont.AG}</div><div class="t">Aguardando dono</div></div>
    <div class="kpi"><div class="n">${cont.OK}</div><div class="t">Concluídos</div></div>
  </div>
  ${ger && !S.f.mesa ? tabela('Progresso por mesa', 'Mesa', porM) : ''}
  ${sup ? tabela('Carteira por vendedor', 'Vend.', porV) : ''}
  <div class="box"><h3>${sup ? 'Ações por usuário' : 'Resumo dos meus envios'}</h3><div class="scroll"><table class="tb">
    <tr><th>Usuário</th><th>Enviados</th><th>Confirm.</th><th>Aguard.</th><th>Recus.</th><th>Fixos</th><th>Inválidos</th></tr>
    ${usuarios.map(u => { const o = porU[u]; return `<tr><td><b>${esc(u)}</b></td><td>${o.env}</td><td>${o.conf}</td><td>${o.pend}</td><td>${o.rec}</td><td>${o.fixo}</td><td>${o.inv}</td></tr>`; }).join('') || '<tr><td colspan="7" class="vazio">Nada enviado ainda.</td></tr>'}
  </table></div></div>
  <div class="box"><h3>Histórico</h3>
    <div class="filtros" style="border:0;padding:0;margin-bottom:8px">
      <select class="in" id="pu"><option value="">Todos usuários</option>${usuarios.map(u => `<option ${S.pf.u === u ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select>
      <select class="in" id="pst"><option value="">Todos status</option>${Object.keys(ST_INFO).map(s => `<option value="${esc(s)}" ${S.pf.st === s ? 'selected' : ''}>${esc(ST_INFO[s][0])}</option>`).join('')}</select>
    </div>
    <div class="scroll"><table class="tb">
      <tr><th>Data</th><th>Usuário</th><th>Cliente</th><th>Contato</th><th>Status</th></tr>
      ${filtrados.map(r => { const c = cliPorCod.get(r.c); return `<tr data-cli="${esc(r.c)}" style="cursor:pointer"><td>${dataBR(r.dt)}${r.local ? ' ⏳' : ''}</td><td>${esc(r.u)}</td><td>${esc(c ? (c.s || c.r) : r.c)}</td><td>${esc(r.vi)}<br><small>${esc(r.tp)} · ${esc(r.cn)}${r.pa && r.tp === 'EMAIL' ? ' p/ ' + esc(r.pa) : ''}</small></td><td>${chip(r.st)}${r.rs ? '<br><small>' + dataBR(r.rs) + '</small>' : ''}</td></tr>`; }).join('') || '<tr><td colspan="5" class="vazio">Sem registros.</td></tr>'}
    </table></div>
  </div>`;
  if ($('#pmesa')) $('#pmesa').onchange = e => { S.f.mesa = e.target.value; renderPainel(); };
  $('#pu').onchange = e => { S.pf.u = e.target.value; renderPainel(); };
  $('#pst').onchange = e => { S.pf.st = e.target.value; renderPainel(); };
  $('#main').querySelectorAll('tr[data-cli]').forEach(tr => tr.onclick = () => {
    if (!cliPorCod.has(tr.dataset.cli)) return;
    S.cli = tr.dataset.cli; S.view = 'detalhe'; render(); window.scrollTo(0, 0);
  });
}

/* ================================================================
   SINCRONIZAÇÃO (fila do aparelho -> planilha -> status de volta)
   ================================================================ */
async function sincronizar(manual) {
  if (S.syncing) return;
  if (!online()) { barra(); if (manual) toast('Sem internet. Tudo continua salvo no aparelho.'); return; }
  S.syncing = true; barra();
  try {
    // 1) envia a fila em lotes (por sessão)
    let voltas = 0;
    while (voltas++ < 50) {
      const f = fila.ler();
      if (!f.length) break;
      const auth = f[0].auth;
      const lote = f.filter(i => i.auth === auth).slice(0, 40);
      const envio = lote.map(i => { const o = Object.assign({}, i); delete o.auth; return o; });
      let r;
      try { r = await api({ acao: 'sync', token: auth, itens: envio, retornar: false }); }
      catch (e) { if (e.servidor && /sess/i.test(e.message)) break; throw e; } // itens ficam guardados
      const ok = new Set(r.aceitos || []);
      fila.gravar(fila.ler().filter(i => !ok.has(i.id)));   // relê: pode ter entrado item novo durante o envio
      if (!ok.size) break;
    }
    // 2) baixa status atualizados (e a base de clientes quando necessário)
    if (S.sess) {
      const velha = !S.dadosEm || (Date.now() - S.dadosEm) > (C.ATUALIZAR_BASE_HORAS || 6) * 3600e3;
      const r = await api({ acao: velha ? 'dados' : 'sync', token: S.sess.token, itens: [] }, 90000);
      if (r.clientes) { S.clientes = r.clientes; S.dadosEm = Date.now(); }
      if (r.registros) S.registros = r.registros;
      salvarDados();
    }
    S.erro = ''; S.ultimaSync = Date.now(); LS.set('ultimaSync', S.ultimaSync);
    if (manual) toast('Sincronizado com a planilha ✔');
  } catch (e) {
    S.erro = e.message;
    if (e.servidor && /sess/i.test(e.message) && S.sess) { toast('Sessão expirada. Entre novamente – seus envios continuam salvos.', 5000); LS.del('sessao'); S.sess = null; S.syncing = false; return renderLogin(); }
    if (manual) toast('Não foi possível sincronizar: ' + e.message, 4000);
  } finally {
    S.syncing = false;
    if (S.sess) {
      reindexar(); barra();
      if (S.view === 'detalhe') renderItens();
      else if (!document.activeElement || document.activeElement.id !== 'fq') {
        const y = window.scrollY;
        if (S.aba === 'painel') renderPainel(); else renderLista();
        window.scrollTo(0, y);
      }
    }
  }
}

function backup() {
  const dados = JSON.stringify({ geradoEm: new Date().toISOString(), fila: fila.ler() }, null, 2);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([dados], { type: 'application/json' }));
  a.download = 'pendentes-' + (S.sess ? S.sess.usuario : '') + '-' + Date.now() + '.json';
  document.body.appendChild(a); a.click(); a.remove();
}

/* ================================================================
   INÍCIO
   ================================================================ */
(function init() {
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  window.addEventListener('online', () => { barra(); sincronizar(); });
  window.addEventListener('offline', barra);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sincronizar(); });
  setInterval(() => sincronizar(), C.INTERVALO_SYNC_MS || 60000);
  if (S.sess) { carregarDados(); iniciarApp(); sincronizar(); }
  else { renderLogin(); if (fila.ler().length) sincronizar(); }
})();
