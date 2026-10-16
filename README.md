# WinBig

Lucky-draw prize website: customers sign up, buy ticket packages, pay with Yoco, spin a wheel for bonus
entries, and you spin the winner wheel in the admin panel to draw a random winner.

## Run it on your computer

Requires [Node.js](https://nodejs.org) 20 or newer.

```bash
cd winbig
npm install          # first time only
cp .env.example .env # first time only
npm start
```

- Website: http://localhost:3000
- Admin panel: http://localhost:3000/admin. **The first time you open it, it asks you to create the admin password.**

With no Yoco key the site runs in **demo mode**: a pretend payment page replaces Yoco so you can test
everything without being charged.

## How it works

- **Customers** sign up with first name, surname, email, cellphone number and a password. Each gets a
  unique **customer ID** (e.g. `WBC-00042`). Every ticket they buy is linked to that ID, and their
  **My tickets** page shows all their entries.
- **Tickets**: every entry is one ticket (e.g. `WB000123`). After paying, the customer spins the bonus wheel
  for extra entries.
- **The draw**: the winner wheel gives each customer a slice sized by their number of entries, so more
  entries means a bigger chance. The server picks one ticket at random and the wheel stops on its owner.

## Admin panel

| Page            | What you can do                                                                     |
|-----------------|-------------------------------------------------------------------------------------|
| Prizes          | Name, value, photo, description, **start and end date**. Schedule the next prize ahead. |
| Ticket packages | Set prices and entries (e.g. R100 = 1, R400 = 5, R800 = 10).                         |
| Spin wheel      | Bonus amounts (1, 2, 3, 4…) and how likely each one is.                              |
| Customers       | Customer ID, name, surname, email, phone, entries. Reset a forgotten password. CSV. |
| Orders          | Every purchase and its ticket numbers. Search, CSV.                                  |
| Draw winner     | Spin the winner wheel. Shows everyone's chance, and the winner's contact details.   |
| Payments        | Paste your Yoco key and website address.                                             |

**Forgot the admin password?** Stop the site and run `npm run reset-admin`, then open `/admin` to create a new one.

## Connecting Yoco

1. Yoco Business Portal → **Sell Online → Payment Gateway** (Yoco app: **Sales → Payment Gateway**).
   Copy the **secret key**. Start with the test key (`sk_test_…`).
2. Put the site online on its `https://` address.
3. Admin → **Payments**: paste the key, enter the website address, click **Save & connect**.
   This also tells Yoco to notify WinBig when payments succeed, which is what issues tickets.
4. Buy a ticket with a Yoco test card. When it works, paste your live key (`sk_live_…`) and save again.

Yoco can't notify a site running only on your computer, so test real Yoco payments once the site is online.

## Hosting

Any host that runs Node.js with a **persistent disk** works (a VPS, or Render/Railway with a volume).
Everything is stored in the `data/` folder (database + prize photos). **Back it up regularly.**
If you open `/admin` for the first time from another computer, it asks for a one-time setup code that is
printed in the server log, so nobody else can claim your admin panel first.

## Files

```
server.js                web server
src/db.js                database tables + first-run sample data
src/yoco.js              Yoco Checkout API + webhook signature check
src/orders.js            payments, bonus spin and winner draw logic
src/auth.js              customer sign-in sessions
src/account-routes.js    sign up / sign in / my tickets API
src/public-routes.js     website API (checkout, order status, spin)
src/admin-routes.js      admin API
src/webhooks.js          Yoco payment notifications
scripts/reset-admin.js   npm run reset-admin
public/                  website pages, admin panel, styles, images
```
