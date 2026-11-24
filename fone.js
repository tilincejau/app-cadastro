/* Normalização de telefones e e-mails da base */
(function (g) {
  'use strict';

  /**
   * Recebe qualquer formato da base ("014-99768-6495", 14996737006, "014-03667-1211")
   * e devolve { ddd, num, tipo: 'CELULAR'|'FIXO', fmt, chave, intl } ou null se vazio/zero.
   */
  function normFone(raw, dddPadrao) {
    let s = String(raw == null ? '' : raw).replace(/\D/g, '');
    if (!s || /^0+$/.test(s)) return null;
    s = s.replace(/^0+/, '');
    if (s.length >= 12 && s.startsWith('55')) s = s.slice(2);
    let ddd = '', n = s;
    if (s.length >= 10) { ddd = s.slice(0, 2); n = s.slice(2); }
    n = n.replace(/^0+/, '');
    if (n.length < 8 || n.length > 9) {
      const bruto = String(raw).trim();
      return { ddd: '', num: s, tipo: 'REVISAR', fmt: bruto, padrao: bruto, chave: 'X' + s, intl: '' };
    }
    if (!ddd) ddd = String(dddPadrao || '');
    let tipo;
    if (n.length === 9) tipo = n[0] === '9' ? 'CELULAR' : 'FIXO';
    else if ('6789'.indexOf(n[0]) >= 0) { tipo = 'CELULAR'; n = '9' + n; }
    else tipo = 'FIXO';
    const corpo = n.length === 9 ? n.slice(0, 5) + '-' + n.slice(5) : n.slice(0, 4) + '-' + n.slice(4);
    const meio = n.length === 8 ? '0' + n : n;
    return {
      ddd: ddd, num: n, tipo: tipo,
      fmt: (ddd ? '(' + ddd + ') ' : '') + corpo,
      padrao: '0' + (ddd || '00') + '-' + meio.slice(0, 5) + '-' + meio.slice(5),
      chave: ddd + n,
      intl: '55' + ddd + n
    };
  }

  /** Máscara enquanto digita: 000-00000-0000 (no máximo 12 números; o 0 do DDD é colocado sozinho) */
  function mascaraFone(v) {
    let d = String(v || '').replace(/\D/g, '');
    if (d && d[0] !== '0') d = '0' + d;
    d = d.slice(0, 12);
    if (d.length <= 3) return d;
    if (d.length <= 8) return d.slice(0, 3) + '-' + d.slice(3);
    return d.slice(0, 3) + '-' + d.slice(3, 8) + '-' + d.slice(8);
  }

  /**
   * Valida o telefone digitado.
   * Celular: 000-00000-0000 exato (12 números, começa com 9 depois do DDD).
   * Fixo: 000-00000-0000 com 0 antes do número (ex.: 014-03667-1211) ou 000-0000-0000 (11 números).
   */
  function validarFone(v) {
    const d = String(v || '').replace(/\D/g, '');
    const ddd = d.slice(1, 3);
    const erroPadrao = 'Use o padrão 000-00000-0000 (ex.: 014-99798-3516). Fixo: 014-03667-1211.';
    if (d[0] !== '0' || !/^[1-9][1-9]$/.test(ddd)) return { ok: false, erro: 'DDD inválido. ' + erroPadrao };
    let num;
    if (d.length === 12 && d[3] === '9') num = d.slice(3);
    else if (d.length === 12 && d[3] === '0' && '2345'.indexOf(d[4]) >= 0) num = d.slice(4);
    else if (d.length === 11 && '2345'.indexOf(d[3]) >= 0) num = d.slice(3);
    else if (d.length < 11 || (d.length === 11 && d[3] === '9')) return { ok: false, erro: 'Faltam números. ' + erroPadrao };
    else return { ok: false, erro: 'Número inválido. ' + erroPadrao };
    return Object.assign({ ok: true }, normFone(ddd + num));
  }

  function normEmail(raw) {
    const s = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!s || s === '0' || s.indexOf('@') < 1) return '';
    return s;
  }

  function emailValido(s) { return /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(s); }

  g.normFone = normFone;
  g.normEmail = normEmail;
  g.emailValido = emailValido;
  g.mascaraFone = mascaraFone;
  g.validarFone = validarFone;
  if (typeof module !== 'undefined') module.exports = { normFone: normFone, normEmail: normEmail, emailValido: emailValido, mascaraFone: mascaraFone, validarFone: validarFone };
})(typeof window !== 'undefined' ? window : globalThis);
