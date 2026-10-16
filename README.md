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

**Forgot the admin password?** On a server run `sudo winbig reset-admin`; on your own computer stop the site and
run `npm run reset-admin`. Then open `/admin` to create a new one.

## Connecting Yoco

1. Yoco Business Portal → **Sell Online → Payment Gateway** (Yoco app: **Sales → Payment Gateway**).
   Copy the **secret key**. Start with the test key (`sk_test_…`).
2. Put the site online on its `https://` address.
3. Admin → **Payments**: paste the key, enter the website address, click **Save & connect**.
   This also tells Yoco to notify WinBig when payments succeed, which is what issues tickets.
4. Buy a ticket with a Yoco test card. When it works, paste your live key (`sk_live_…`) and save again.

Yoco can't notify a site running only on your computer, so test real Yoco payments once the site is online.

## Install on an AlmaLinux server

`install.sh` sets everything up on AlmaLinux 8, 9 or 10 (or Rocky Linux / RHEL): Node.js, a `winbig`
system service that starts on boot, nginx with a free HTTPS certificate, the firewall and SELinux.

1. Point your domain's DNS (an **A record**) at the server's IP address.
2. Log in to the server as root and run:

   ```bash
   dnf install -y git
   git clone https://github.com/dadad132/WINBIG.git
   cd WINBIG
   bash install.sh --domain winbig.co.za --email you@example.com
   ```

3. Open `https://your-domain/admin`, create the admin password, and enter the one-time **setup code**
   the installer printed (this stops anyone else claiming your admin panel first).

Leave out `--domain` to try it on `http://SERVER-IP:3000` first. Yoco needs HTTPS, so add the domain
before taking payments by running the installer again with `--domain`.

**Updating** keeps your data and settings: `cd WINBIG && git pull && bash install.sh`

**On the server:**

| Command                      | What it does                                               |
|------------------------------|------------------------------------------------------------|
| `sudo winbig check`          | Checks everything and explains what to fix                 |
| `sudo winbig status`         | Is the website running?                                    |
| `sudo winbig logs`           | Live log                                                   |
| `sudo winbig restart`        | Restart the website                                        |
| `sudo winbig backup`         | Make an encrypted backup now (also automatic every night)  |
| `sudo winbig backups`        | List the backups                                           |
| `sudo winbig restore FILE`   | Put a backup back (current data is backed up first)        |
| `sudo winbig show-key`       | Show the database encryption key                           |
| `sudo winbig setup-code`     | Show the one-time code for creating the admin password     |
| `sudo winbig reset-admin`    | Forgot the admin password                                  |
| `sudo winbig settings`       | Edit `/etc/winbig/winbig.env`                              |

Where things live: the app is in `/opt/winbig`, settings in `/etc/winbig/winbig.env`, the encryption key in
`/etc/winbig/secret.env`, the database and prize photos in `/var/lib/winbig/data`, and backups in
`/var/backups/winbig`.

## Your data: restarts, encryption and backups

- **Restarts are safe.** Everything is saved on disk the moment it happens. Restarting WinBig, rebooting the
  server or re-running the installer never deletes customer data.
- **Customer data is encrypted** (AES-256, SQLCipher format): names, emails, phone numbers, orders, tickets
  and your Yoco key. A copy of the database file or a backup is useless without the key. Passwords are
  never stored at all, only a one-way scrambled version (scrypt) that can't be turned back into the password.
- **The key is kept separately** in `/etc/winbig/secret.env`, readable only by root. The installer shows it
  once. **Save it in a password manager.** Without it, nobody (not even you) can open the backups.
- **Encrypted backups** are made every night and kept for 14 days. Copy them off the server now and then
  (to your computer or cloud storage): a backup on the same server doesn't help if the server itself is lost.
- **Security updates** for the server install automatically every day.

What encryption can't do: if an attacker gets full control (root) of the running server, they can reach
anything the website itself can read. Keep that from happening: log in with SSH keys rather than passwords,
keep the root password long and unique, and don't share server access.

## Other hosting

Any host that runs Node.js with a **persistent disk** works. Everything is stored in the `data/` folder
(or `DATA_DIR`). If you open `/admin` for the first time from another computer, it asks for a one-time
setup code that is printed in the server log.

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
