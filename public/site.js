// EDIT THIS ONE FILE: your business details appear on every page and policy.
window.BIZ = {
  legalName: '[YOUR LEGAL BUSINESS NAME]',
  address: '[YOUR MAILING ADDRESS]',
  email: '[YOUR SUPPORT EMAIL]',
  county: '[YOUR COUNTY]',
  state: 'Arkansas',
  updated: 'September 28, 2026',
};
document.querySelectorAll('[data-biz]').forEach((el) => { if (BIZ[el.dataset.biz]) el.textContent = BIZ[el.dataset.biz]; });
document.querySelectorAll('[data-mail]').forEach((a) => { a.href = 'mailto:' + BIZ.email; });
