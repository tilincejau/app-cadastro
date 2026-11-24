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
      return { ddd: '', num: s, tipo: 'REVISAR', fmt: bruto, chave: 'X' + s, intl: '' };
    }
    if (!ddd) ddd = String(dddPadrao || '');
    let tipo;
    if (n.length === 9) tipo = n[0] === '9' ? 'CELULAR' : 'FIXO';
    else if ('6789'.indexOf(n[0]) >= 0) { tipo = 'CELULAR'; n = '9' + n; }
    else tipo = 'FIXO';
    const corpo = n.length === 9 ? n.slice(0, 5) + '-' + n.slice(5) : n.slice(0, 4) + '-' + n.slice(4);
    return {
      ddd: ddd, num: n, tipo: tipo,
      fmt: (ddd ? '(' + ddd + ') ' : '') + corpo,
      chave: ddd + n,
      intl: '55' + ddd + n
    };
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
  if (typeof module !== 'undefined') module.exports = { normFone: normFone, normEmail: normEmail, emailValido: emailValido };
})(typeof window !== 'undefined' ? window : globalThis);
