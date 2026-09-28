// EDIT THIS ONE FILE: your business details appear on every page and policy.
window.BIZ = {
  legalName: 'Breckin Copeland (doing business as FERMO)',
  address: '509 Jill Dr, Jonesboro, AR, United States',
  email: 'fermocases.shop@gmail.com',
  county: 'Craighead',
  state: 'Arkansas',
  updated: 'September 28, 2026',
};
document.querySelectorAll('[data-biz]').forEach((el) => { if (BIZ[el.dataset.biz]) el.textContent = BIZ[el.dataset.biz]; });
document.querySelectorAll('[data-mail]').forEach((a) => { a.href = 'mailto:' + BIZ.email; });
