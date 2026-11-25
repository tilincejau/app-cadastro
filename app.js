/* ================================================================
   LINCE DISTRIBUIDORA – App Cadastral (conferência de telefone/e-mail)
   Funciona offline: toda ação é gravada primeiro no aparelho (fila)
   e enviada à planilha quando houver internet. Nada se perde.
   ================================================================ */
'use strict';
const APP_VERSAO = '13';

const C = window.CONFIG;
const DIAS = { 1: 'Segunda', 2: 'Terça', 3: 'Quarta', 4: 'Quinta', 5: 'Sexta' };
const DIAS_C = { 1: 'Seg', 2: 'Ter', 3: 'Qua', 4: 'Qui', 5: 'Sex' };
const CAMPOS_FONE = ['Fone(1)', 'Fone(2)', 'Cel(1)', 'Cel(2)'];
const ST = {
  PENDENTE: 'PENDENTE', CONFIRMADO: 'CONFIRMADO', RECUSADO: 'RECUSADO',
  FIXO: 'FIXO CONFERIDO', INVALIDO: 'INVALIDO', CONFERIDO: 'CONFERIDO'
};
const ST_INFO = {
  PENDENTE: ['Aguardando confirmação', 'ouro'],
  CONFIRMADO: ['Confirmado', 'verde'],
  RECUSADO: ['Dono recusou', 'verm'],
  'FIXO CONFERIDO': ['Fixo conferido', 'verde'],
  INVALIDO: ['Inválido', 'cinza'],
  CONFERIDO: ['Conferido', 'verde'],
  'NOVO - NAO ENVIADO': ['Novo · enviar', 'azul']
};
const RESOLVIDO = new Set([ST.CONFIRMADO, ST.RECUSADO, ST.FIXO, ST.INVALIDO, ST.CONFERIDO]);
const AGUARDA = new Set([ST.PENDENTE]);
const SIT = {
  NI: ['Não iniciado', 'cinza'], EA: ['Em andamento', 'azul'],
  AG: ['Aguard. WhatsApp', 'ouro'], OK: ['Concluído', 'verde']
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
  if (d) { S.clientes = d.clientes || []; S.registros = d.registros || []; S.dadosEm = d.em || 0; S.baseHash = d.hash || ''; }
  LS.del('extras_' + S.sess.usuario);   // versões antigas guardavam contatos aqui; agora tudo vem da planilha
  reindexar();
}
function salvarDados() {
  if (!S.sess) return;
  try {
    LS.set('dados_' + S.sess.usuario, { clientes: S.clientes, registros: S.registros, em: S.dadosEm, hash: S.baseHash || '' });
  } catch (e) { toast('Memória do aparelho cheia. Os envios pendentes continuam salvos.'); }
}

function statusLocal(it) {
  if (it.acao === 'CONFERIDO') return ST.FIXO;
  if (it.acao === 'INVALIDO') return ST.INVALIDO;
  if (it.acao === 'NOVO') return 'NOVO - NAO ENVIADO';
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
    itens.push({ k, tp: n.tipo, valor: n.padrao, n, origem, vb, ordem: CAMPOS_FONE.indexOf(origem) >= 0 ? CAMPOS_FONE.indexOf(origem) : 100 + itens.length });
  };
  const addEmail = (raw, origem, vb) => {
    const e = normEmail(raw); if (!e) return;
    const k = 'E' + e; if (vistos.has(k)) return; vistos.add(k);
    itens.push({ k, tp: 'EMAIL', valor: e, origem, vb, ordem: origem === 'Email-NF-e' ? 0 : 100 + itens.length });
  };
  (cli.f || []).forEach((raw, i) => addFone(raw, CAMPOS_FONE[i], raw));
  addEmail(cli.e, 'Email-NF-e', cli.e);
  regs.forEach(r => r.tp === 'EMAIL' ? addEmail(r.vi, r.or || 'NOVO', r.vb) : addFone(r.vi, r.or || 'NOVO', r.vb));
  itens.forEach(it => {
    it.regs = regs.filter(r => chaveReg(r) === it.k);
    const conf = it.regs.find(r => r.st === ST.CONFIRMADO);
    it.ult = it.regs[0] || null;
    it.st = conf ? ST.CONFIRMADO : (it.ult ? it.ult.st : '');
  });
  // contato que substituiu outro herda a posição dele (ex.: o novo do Fone(1) continua sendo a 1ª opção)
  for (let volta = 0; volta < 3; volta++) itens.forEach(it => {
    const m = /^Substitui (.+)$/.exec(it.origem || ''); if (!m) return;
    const antigo = itens.find(o => o !== it && o.valor === m[1].trim());
    if (antigo) it.ordem = antigo.ordem + 0.5;
  });
  itens.sort((a, b) => a.ordem - b.ordem);
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
    <input class="in" id="lu" type="text" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="username" value="${esc(LS.get('ultimoUsuario', ''))}">
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
    S.clientes = r.clientes; S.registros = r.registros; S.dadosEm = Date.now(); S.baseHash = r.hash || '';
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
      <button data-aba="painel" class="${S.aba === 'painel' ? 'on' : ''}">${sup ? 'Acompanhamento' : 'Meu resumo'}</button>
    </nav>` : ''}
    <div class="menu hide" id="menu">
      <button data-m="sync">⟳ Sincronizar agora</button>
      <button data-m="base">⬇ Atualizar clientes da planilha</button>
      <button data-m="backup">💾 Salvar cópia dos pendentes</button>
      <button data-m="sair">⎋ Sair</button>
      <div class="ver">Versão ${APP_VERSAO}</div>
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
    ${Object.keys(SIT).filter(k => k !== 'AG' || cont.AG).map(k => `<span class="chip ${f.sit === k ? SIT[k][1] : 'cinza'}" data-sit="${k}" style="${f.sit === k ? 'outline:2px solid currentColor' : ''}">${SIT[k][0]} ${cont[k]}</span>`).join('')}
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
  <div class="box envio">
    <h3>Conferência dos contatos</h3>
    <div class="dica" style="margin:0 0 6px">Confira com o cliente: <b>✔</b> se está correto, <b>✎</b> para corrigir ou remover.</div>
    <div class="lb">📱 Telefones</div>
    <div id="listaT"></div>
    <details class="addt"><summary>+ Adicionar telefone</summary>
      <div class="add"><input class="in" id="novoT" type="tel" inputmode="numeric" maxlength="14" placeholder="000-00000-0000"><button class="btn ouro" id="addT">Adicionar</button></div>
    </details>
    <div class="lb" style="margin-top:12px">📧 E-mail</div>
    <div id="listaE"></div>
    <details class="addt"><summary>+ Adicionar e-mail</summary>
      <div class="add"><input class="in" id="novoE" type="email" inputmode="email" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="nome@exemplo.com.br"><button class="btn ouro" id="addE">Adicionar</button></div>
    </details>
    <button class="btn full" id="tudoOk">✔ Todos os contatos estão corretos</button>
  </div>`;
  $('#contato').onchange = e => LS.set('contato_' + cli.c, e.target.value.trim());
  aplicarMascara($('#novoT'));
  $('#addT').onclick = () => {
    const v = validarFone($('#novoT').value);
    if (!v.ok) return toast(v.erro, 4500);
    if (jaExiste(cli, 'T' + v.chave)) return toast('Esse telefone já está no cadastro.');
    gravar([registrarNovo(cli, 'FONE', v.padrao, 'NOVO')]); $('#novoT').value = '';
    toast('Telefone adicionado e conferido ✔');
  };
  $('#addE').onclick = () => {
    const v = normEmail($('#novoE').value);
    if (!emailValido(v)) return toast('E-mail inválido.');
    if (jaExiste(cli, 'E' + v)) return toast('Esse e-mail já está no cadastro.');
    gravar([registrarNovo(cli, 'EMAIL', v, 'NOVO')]); $('#novoE').value = '';
    toast('E-mail adicionado e conferido ✔');
  };
  $('#tudoOk').onclick = () => {
    const itens = itensDoCliente(cli).filter(i => i.st !== ST.INVALIDO);
    if (!itens.some(i => i.tp !== 'EMAIL')) return toast('Adicione pelo menos um telefone do cliente.', 3500);
    if (itens.some(i => i.tp === 'REVISAR')) return toast('Há número fora do padrão. Corrija com ✎ antes de concluir.', 4000);
    const faltam = itens.filter(i => !OK_VENDEDOR.has(i.st));
    if (!faltam.length) return toast('Todos os contatos já estão conferidos ✔');
    gravar(faltam.map(i => novoReg(cli, i, { acao: 'CONFERIDO' })));
    toast('Conferência concluída ✔');
  };
  renderItens();
}

function adicionarExtra() { renderItens(); }


/** Cria um registro (vai para a fila do aparelho e depois para a planilha). */
function novoReg(cli, item, extra) {
  const contato = ($('#contato') && $('#contato').value.trim()) || cli.ct || '';
  return Object.assign({
    id: novoId(), token: '', dt: new Date().toISOString(), usuario: S.sess.usuario, auth: S.sess.token,
    c: cli.c, ct: contato, tp: item.tp === 'REVISAR' ? 'FIXO' : item.tp, or: item.origem, vb: item.vb || '', vi: item.valor,
    cn: 'NENHUM', pa: '', acao: 'ENVIO'
  }, extra || {});
}

/** Registra na planilha um contato digitado pelo vendedor (já conferido por ele). */
function registrarNovo(cli, tp, valor, origem) {
  const n = tp === 'EMAIL' ? null : normFone(valor);
  return novoReg(cli, { tp: tp === 'EMAIL' ? 'EMAIL' : (n ? n.tipo : 'FIXO'), origem, valor }, { acao: 'CONFERIDO' });
}


function jaExiste(cli, k) {
  return itensDoCliente(cli).some(i => i.k === k && i.st !== ST.INVALIDO);
}

function aplicarMascara(inp) {
  inp.addEventListener('input', () => { inp.value = mascaraFone(inp.value); });
}

/**
 * Corrigir: o vendedor digita o valor certo (o antigo vira INVALIDO e o novo já fica CONFERIDO).
 * Se o cliente tiver outro telefone/e-mail, também dá para só remover este.
 * Se for o único, é obrigatório digitar o novo.
 */
function pedirCorrecao(cli, it, restantes) {
  const email = it.tp === 'EMAIL';
  const nomeTipo = email ? 'e-mail' : 'telefone';
  const fundo = document.createElement('div');
  fundo.className = 'modal-fundo';
  fundo.innerHTML = `<div class="modal">
    <div class="modal-t">✎ Corrigir ${nomeTipo}</div>
    <div class="modal-old2">Atual: <b>${esc(it.valor)}</b></div>
    <p>Digite o ${nomeTipo} correto do cliente:</p>
    ${email
      ? '<input class="in" id="subst" type="email" inputmode="email" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="nome@exemplo.com.br">'
      : '<input class="in" id="subst" type="tel" inputmode="numeric" maxlength="14" placeholder="000-00000-0000"><div class="dica">Celular: 014-99798-3516 · Fixo: 014-03667-1211</div>'}
    <div class="modal-erro" id="substErro"></div>
    <div class="modal-b"><button class="btn sec" id="substCanc">Cancelar</button><button class="btn" id="substOk">Salvar</button></div>
    ${restantes.length
      ? `<button class="btn perigo full" id="substRem" style="margin-top:8px">🗑 Só remover este ${nomeTipo} (manter ${restantes.length > 1 ? 'os outros' : esc(restantes[0].valor)})</button>`
      : `<div class="dica" style="margin-top:8px">Este é o único ${nomeTipo} do cliente, então é obrigatório informar o correto.</div>`}
  </div>`;
  document.body.appendChild(fundo);
  const inp = $('#subst', fundo), err = $('#substErro', fundo);
  inp.value = it.tp === 'REVISAR' ? '' : it.valor;
  if (!email) aplicarMascara(inp);
  setTimeout(() => { inp.focus(); inp.select(); }, 50);
  const fechar = () => fundo.remove();
  $('#substCanc', fundo).onclick = fechar;
  if ($('#substRem', fundo)) $('#substRem', fundo).onclick = () => {
    gravar([novoReg(cli, it, { acao: 'INVALIDO' })]); fechar();
    toast((email ? 'E-mail' : 'Telefone') + ' removido (marcado como inválido).');
  };
  const salvar = () => {
    let valor, k, tp;
    if (email) {
      valor = normEmail(inp.value);
      if (!emailValido(valor)) { err.textContent = 'Digite um e-mail válido.'; return; }
      k = 'E' + valor; tp = 'EMAIL';
    } else {
      const v = validarFone(inp.value);
      if (!v.ok) { err.textContent = v.erro; return; }
      valor = v.padrao; k = 'T' + v.chave; tp = 'FONE';
    }
    if (k === it.k) {   // não mudou nada: é o mesmo, então está correto
      if (!OK_VENDEDOR.has(it.st)) gravar([novoReg(cli, it, { acao: 'CONFERIDO' })]);
      fechar(); return toast('Mantido e conferido ✔');
    }
    if (jaExiste(cli, k)) { err.textContent = 'Esse contato já está no cadastro.'; return; }
    gravar([novoReg(cli, it, { acao: 'INVALIDO' }), registrarNovo(cli, tp, valor, 'Substitui ' + it.valor)]);
    fechar();
    toast('Corrigido e conferido ✔');
  };
  $('#substOk', fundo).onclick = salvar;
  inp.onkeydown = e => { if (e.key === 'Enter') salvar(); };
}

const OK_VENDEDOR = new Set(['CONFERIDO', 'FIXO CONFERIDO', 'CONFIRMADO']);

function renderItens() {
  const cli = clienteAtual(); if (!cli || !$('#listaT')) return;
  const itens = itensDoCliente(cli);
  const vis = itens.filter(i => i.st !== ST.INVALIDO);   // inválidos saem da tela
  const tel = vis.filter(i => i.tp !== 'EMAIL'), em = vis.filter(i => i.tp === 'EMAIL');
  $('#listaT').innerHTML = tel.length ? tel.map((it, n) => linhaContato(it, n + 1)).join('') : '<div class="vazio-p">Nenhum telefone. Adicione um abaixo.</div>';
  $('#listaE').innerHTML = em.length ? em.map((it, n) => linhaContato(it, n + 1)).join('') : '<div class="vazio-p">Nenhum e-mail. Adicione se o cliente tiver.</div>';
  const handler = e => {
    const b = e.target.closest('[data-acao]'); if (!b) return;
    const it = itens.find(i => i.k === b.dataset.k); if (!it) return;
    if (b.dataset.acao === 'OK') { gravar([novoReg(cli, it, { acao: 'CONFERIDO' })]); return toast('Conferido ✔'); }
    const restantes = vis.filter(i => i !== it && (i.tp === 'EMAIL') === (it.tp === 'EMAIL'));
    pedirCorrecao(cli, it, restantes);
  };
  $('#listaT').onclick = handler; $('#listaE').onclick = handler;
  const tudo = vis.length && vis.every(i => OK_VENDEDOR.has(i.st));
  $('#tudoOk').innerHTML = tudo ? '✔ Contatos conferidos' : '✔ Todos os contatos estão corretos';
  $('#tudoOk').classList.toggle('feito', !!tudo);
}

function linhaContato(it, n) {
  const k = esc(it.k);
  const tipo = it.tp === 'CELULAR' ? 'Celular' : it.tp === 'FIXO' ? 'Fixo' : it.tp === 'EMAIL' ? 'E-mail' : 'Fora do padrão';
  const ok = OK_VENDEDOR.has(it.st);
  let b = '';
  if (!ok && it.tp !== 'REVISAR') b += `<button class="btn peq bok" data-acao="OK" data-k="${k}">✔ Correto</button>`;
  b += `<button class="btn sec peq" data-acao="EDIT" data-k="${k}">✎${ok ? '' : ' Corrigir'}</button>`;
  const quando = it.ult && OK_VENDEDOR.has(it.ult.st) ? ' <small>' + dataBR(it.ult.dt) + ' · ' + esc(it.ult.u) + '</small>' : '';
  return `<div class="outro${ok ? ' ok' : ''}">
    <div class="o1"><span class="val${it.tp === 'EMAIL' ? '' : ' tel'}">${esc(it.valor)}</span><span class="ob">${b}</span></div>
    <div class="o2">${it.tp !== 'EMAIL' ? `<span class="chip ouro">${n}ª opção</span>` : ''}<span class="chip ${it.tp === 'REVISAR' ? 'verm' : 'cinza'}">${tipo}</span>${ok ? chip(it.st) : (it.st && it.st !== 'NOVO - NAO ENVIADO' ? chip(it.st) : '<span class="chip cinza">A conferir</span>')}${quando}<small class="org">${esc(it.origem)}</small></div>
  </div>`;
}


function nomeBonito(s) {
  const minus = ['da', 'de', 'do', 'das', 'dos', 'e'];
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().split(' ')
    .map((w, i) => (i && minus.includes(w)) ? w : (/^(ltda|me|epp|eireli|s\/a|sa)$/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

function mensagemConfirmacao(cli, contato, link, regs) {
  const primeiro = nomeBonito(String(contato || '').split(/[\s\/]+/)[0]);
  const tel = regs.filter(r => r.tp !== 'EMAIL').map(r => { const n = normFone(r.vi); return n ? n.fmt : r.vi; });
  const em = regs.filter(r => r.tp === 'EMAIL').map(r => r.vi);
  const linhas = [
    `🌾 *${C.EMPRESA}*`,
    '',
    `Olá${primeiro ? ', *' + primeiro + '*' : ''}! 👋`,
    `Estamos atualizando o cadastro de *${nomeBonito(cli.s || cli.r)}* para continuar te atendendo cada vez melhor. 💚`,
    '',
    `Pode confirmar ${tel.length + em.length > 1 ? 'seus contatos' : 'seu contato'}? Leva só *10 segundos* ⏱️`,
    ''
  ];
  tel.forEach(t => linhas.push(`📱 Telefone: *${t}*`));
  em.forEach(e => linhas.push(`📧 E-mail: ${e}`));   // sem negrito: o WhatsApp transforma e-mail em link e quebra o *
  linhas.push('', '👉 *Toque no link para confirmar:*', link, '',
    '🔒 _É só um clique para dizer se o contato é seu. Nunca pedimos senhas, códigos ou pagamentos._', '',
    'Obrigado pela parceria! 🤝');
  return linhas.join('\n');
}

function urlConfirmacao(tokens) {
  const base = C.URL_CONFIRMACAO || new URL('c.html', location.href).href.split('?')[0];
  return base + '?t=' + tokens.join('-');
}

function gravarConferencia() {}


function gravar(regs, forcar) {
  const f = fila.ler(); regs.forEach(r => f.push(r)); fila.gravar(f);   // 1º grava no aparelho (nunca se perde)
  reindexar(); renderItens(forcar); barra();
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
    const o = porU[r.u] = porU[r.u] || { conf: 0, corr: 0, inv: 0, novos: 0, pend: 0 };
    const subst = /^Substitui /.test(r.or || '');
    if (OK_VENDEDOR.has(r.st)) { if (subst) o.corr++; else if (r.or === 'NOVO') o.novos++; else o.conf++; }
    else if (r.st === ST.INVALIDO) o.inv++;
    else if (AGUARDA.has(r.st)) o.pend++;
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

  const tabela = (titulo, rot, mapa) => `<div class="box"><h3>${titulo}</h3><table class="tb fix">
    <tr><th>${rot}</th><th>Cli.</th><th>Inic.</th><th>Aguard.</th><th>OK</th><th style="width:28%">Progresso</th></tr>
    ${Object.keys(mapa).sort((a, b) => a - b).map(v => { const o = mapa[v]; const p = o.tot ? Math.round(o.ini / o.tot * 100) : 0; return `<tr><td><b>${esc(v)}</b></td><td>${o.tot}</td><td>${o.ini}</td><td>${o.ag}</td><td>${o.ok}</td><td><div class="barra"><i style="width:${p}%"></i></div><small>${p}%</small></td></tr>`; }).join('')}
  </table></div>`;
  const resumoU = o => `<div class="mini">
      <div class="v"><b>${o.conf}</b><span>Conferidos</span></div><div class="o"><b>${o.corr}</b><span>Corrigidos</span></div>
      <div><b>${o.novos}</b><span>Adicionados</span></div><div class="r"><b>${o.inv}</b><span>Removidos</span></div>
      ${o.pend ? `<div><b>${o.pend}</b><span>Aguard. (WhatsApp)</span></div>` : ''}</div>`;
  $('#main').innerHTML = `
  ${ger ? `<select class="in" id="pmesa" style="margin-bottom:8px"><option value="">Todas as mesas</option>${Object.keys(porM).sort((a, b) => a - b).map(m => `<option value="${esc(m)}" ${S.f.mesa === m ? 'selected' : ''}>Mesa ${esc(m)}</option>`).join('')}</select>` : ''}
  <div class="cards">
    <div class="kpi"><div class="n">${calc.length}</div><div class="t">Clientes ${ger ? (S.f.mesa ? 'da mesa ' + esc(S.f.mesa) : 'no total') : sup ? 'da mesa' : 'na carteira'}</div></div>
    <div class="kpi o"><div class="n">${calc.length - cont.NI}</div><div class="t">Iniciados</div></div>
    <div class="kpi o"><div class="n">${cont.EA + cont.AG}</div><div class="t">Em andamento</div></div>
    <div class="kpi"><div class="n">${cont.OK}</div><div class="t">Concluídos</div></div>
  </div>
  ${ger && !S.f.mesa ? tabela('Progresso por mesa', 'Mesa', porM) : ''}
  ${sup ? tabela('Carteira por vendedor', 'Vend.', porV) : ''}
  <div class="box"><h3>${sup ? 'Conferências por usuário' : 'Minhas conferências'}</h3>
    ${usuarios.length ? usuarios.map(u => (sup ? `<div class="mini-u">Usuário <b>${esc(u)}</b></div>` : '') + resumoU(porU[u])).join('') : '<div class="vazio">Nada enviado ainda.</div>'}
  </div>
  <div class="box"><h3>Histórico</h3>
    <div class="filtros" style="border:0;padding:0;margin-bottom:6px;${sup ? '' : 'grid-template-columns:1fr'}">
      ${sup ? `<select class="in" id="pu"><option value="">Todos usuários</option>${usuarios.map(u => `<option ${S.pf.u === u ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select>` : ''}
      <select class="in" id="pst"><option value="">Todos os status</option>${Object.keys(ST_INFO).map(s => `<option value="${esc(s)}" ${S.pf.st === s ? 'selected' : ''}>${esc(ST_INFO[s][0])}</option>`).join('')}</select>
    </div>
    <div class="hl">
      ${filtrados.map(r => { const c = cliPorCod.get(r.c); return `<div class="hr" data-cli="${esc(r.c)}">
        <div class="hr1"><b>${esc(c ? (c.s || c.r) : r.c)}</b>${chip(r.st)}</div>
        <div class="hr2">${r.tp === 'EMAIL' ? '📧' : '📱'} ${esc(r.vi)}</div>
        <div class="hr3">${dataBR(r.dt)}${sup ? ' · ' + esc(r.u) : ''} · ${esc(/^Substitui /.test(r.or || '') ? 'corrigido (' + r.or.toLowerCase() + ')' : r.or === 'NOVO' ? 'adicionado' : r.or || '')}${r.rs ? ' · respondido ' + dataBR(r.rs) : ''}${r.local ? ' · <span class="nsinc">⏳ não sincronizado</span>' : ''}</div>
      </div>`; }).join('') || '<div class="vazio">Sem registros.</div>'}
    </div>
  </div>`;
  if ($('#pmesa')) $('#pmesa').onchange = e => { S.f.mesa = e.target.value; renderPainel(); };
  if ($('#pu')) $('#pu').onchange = e => { S.pf.u = e.target.value; renderPainel(); };
  $('#pst').onchange = e => { S.pf.st = e.target.value; renderPainel(); };
  $('#main').querySelectorAll('.hr[data-cli]').forEach(tr => tr.onclick = () => {
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
      // confere a base toda vez; o servidor só manda os clientes se algo mudou na planilha
      const r = await api({ acao: 'dados', token: S.sess.token, hash: S.dadosEm ? S.baseHash : '' }, 90000);
      if (r.clientes) { S.clientes = r.clientes; S.dadosEm = Date.now(); }
      if (r.hash) S.baseHash = r.hash;
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
