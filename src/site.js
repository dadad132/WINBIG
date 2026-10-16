// Website settings the admin can change: the About section, contact details, the live counter and the
// price of one credit.
const { getSetting } = require('./db');

// A starting text for the About section. Replace it with your own words in Admin > Website.
const DEFAULT_ABOUT = {
  who:
    'We are WinBig, a small, proudly South African team. We believe everyone deserves a chance at something ' +
    'big, no matter where they come from.',
  what:
    'We run prize draws for amazing prizes. For a small amount you get spins on our wheel, every spin wins you ' +
    'entries into the draw, and on draw day one winner is picked completely at random by computer. Every entry ' +
    'has exactly the same chance, and we announce every winner.',
  why:
    'We started WinBig because we want to help people. Times are tough for many families, and one prize can ' +
    "change someone's life. With every draw we give ordinary people a real chance to win, and as we grow we " +
    'want to give back to our community.',
};

function siteSettings() {
  return {
    about: { ...DEFAULT_ABOUT, ...getSetting('about', {}) },
    contact: { email: '', phone: '', whatsapp: '', ...getSetting('contact', {}) },
    show_counter: getSetting('show_counter', true),
    credit_price_cents: getSetting('credit_price_cents', 10000), // R100 per credit
  };
}

const creditPrice = () => siteSettings().credit_price_cents;
const MAX_CUSTOM_CREDITS = 500;

module.exports = { siteSettings, creditPrice, MAX_CUSTOM_CREDITS, DEFAULT_ABOUT };
