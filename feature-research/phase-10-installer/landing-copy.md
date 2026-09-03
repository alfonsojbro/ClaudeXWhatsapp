# Landing page copy and design

**Date:** 2026-09-03 · **Branch:** `phase-10-installer` · **Files:** `apps/site/index.html`, `apps/site/landing/`

The public page a person sees before they set anything up. One job: explain what this is, and start setup.

---

## Open question for Alfonso, please read first

The brief I was given describes the **rev 2 hosted model**: sign up with your email, the site creates
your server, and the page states the trade of the hosted address against a bring-your-own-Cloudflare
option.

The plan in this worktree was revised and committed to **rev 3** while I was writing
(`5978438 docs(phase-10): rev 3, apps/installer on the person's own account`). Rev 3 says rev 2 is
withdrawn, that you chose rev 1's shape when asked directly, and that there is **no sign-up gate and
no stored state of any kind**. The installer is deployed by each person to their own Cloudflare
account.

Under rev 3 there is no email sign-up and no hosted address, so the three sentences the brief asked
for would have described a product nobody is building. **I wrote the page to rev 3**, the committed
plan. Two sections carry the whole difference, and both are marked below so you can flip them back in
a few minutes if you reinstate the hosted model.

- Section 3, the three steps.
- Section 5, the second half of "What stays yours".

Nothing else on the page depends on which model wins.

---

## Design read and dials

**Reading this as:** a landing page for a private, self-hosted personal tool, for one technically
comfortable individual, with the calm document-engineering language the project blueprint already
uses, leaning toward native CSS on the blueprint's own token system rather than a new identity.

| Dial | Value | Why |
| --- | --- | --- |
| `DESIGN_VARIANCE` | 6 | Asymmetric split hero and a bento with unequal cells, but the page stays a document. The product is a private tool, not a campaign. |
| `MOTION_INTENSITY` | 3 | Hover, active and focus states only. No scroll animation, no entry transitions. The argument of the page is "this is quiet and it is yours", and animation would work against it. It also keeps the page honest as static HTML with no build step. |
| `VISUAL_DENSITY` | 4 | Normal marketing spacing, 84px section padding. |

**Inherited system, not a new one.** Bricolage Grotesque for display, Source Sans 3 for body,
JetBrains Mono for anything technical. All three are self-hosted as woff2 under
`apps/site/landing/fonts/`, with `apps/site/landing/fonts.css` rewritten to local paths. No font
request leaves the page.

**One accent.** Green (`--wa`) is the only interactive colour: every button, every link underline,
every focus ring. Violet (`--mem`) appears only on memory content, which is the vault file paths.
Amber (`--warn`) appears only on things waiting for a person, which is the confirm gate and the
console queue. That is the blueprint's semantic assignment, not decoration.

**One radius.** 6px on every button, card, panel and input surface.

**One CTA intent.** "Start setup", in the navigation, in the hero and in the closing section. The only
other button is "How it works", which navigates rather than converts.

**Both themes from the same tokens.** Light is the bare `:root`. Dark is redefined twice, once under
`prefers-color-scheme` guarded by `:root:not([data-theme="light"])` and once under
`:root[data-theme="dark"]`, so a future toggle wins in both directions.

---

## The two visuals

Neither is a fake screenshot built from styled boxes.

1. **The hero exchange** is the real conversation from the blueprint, rendered as real chat markup.
   It carries the whole product in four messages: a photo goes in, decisions come back, a capture is
   written to a real vault path, and the confirm gate stops the outbound message. The product is a
   chat, so the hero is a chat.
2. **The console preview** is a genuinely reduced version of the console artifact: the same tiles,
   the same "Waiting on you" queue, the same read-only footer. It is labelled "Sample figures,
   arranged the way the real ones will be", because the numbers are examples.

---

## Final copy, section by section

### Navigation

> ClaudeXWhatsapp · What it does · Setup · What stays yours · Cost · **Start setup**

Four links, one line, 68px tall. The links collapse below 800px and the button never does.

### 1. Hero

> # Your own Claude.
> # In your own WhatsApp.
>
> It runs on a small server you control, and reads your chats, mail and calendar when you ask.
>
> **Start setup**  ·  How it works

**Why.** The repetition of "your own" is the entire positioning, so it carries the headline. Two
sentences give two guaranteed lines at desktop without a font-size trick. The subtext is 18 words and
adds the two facts the headline cannot hold: where it runs, and what it can reach.

Three text elements in the hero. No eyebrow, no trust strip, no tagline under the buttons.

**Alternatives considered.** "Your assistant answers in WhatsApp. Your data never leaves your server."
is more complete but runs to four lines at display size. "A private Claude that lives in your
WhatsApp" leads with the category rather than with ownership.

### 2. What it does

> ## It reads what you already have.
>
> Nothing here is a fresh start. The assistant works from the history, mail and files that are
> already yours.

Five cells, five pieces of content, no empty tile. Sizes are 4+2, 3+3, 6. The first cell is tinted
green because it is the WhatsApp path; the last is tinted violet because it is memory.

| Cell | Copy |
| --- | --- |
| Years of your own WhatsApp | Ask what Ana said about the invoice in March. Your history is stored on your own server and searched there, old chats included, from the first sync onwards. |
| Gmail and Calendar | What is on tomorrow. Which mail still needs a reply. Read when you ask for it, not on a schedule you did not set. |
| Photos, PDFs and voice notes | Send a whiteboard photo, a contract, or a two minute voice note. It reads them and answers in the same thread. |
| A brief at seven, a close at nine | Calendar, unread mail and messages you left hanging in the morning. What happened and what is still open at night. A longer review on Sunday. |
| A second brain that grows on its own | Decisions, people, ideas and projects are written to Markdown files as you talk. They are committed to git, so you can open the whole thing in Obsidian on your laptop and edit it by hand. |

**Why.** Every claim is a capability from sections 1 to 3 of the implementation plan. The routines
cell names the clock times rather than the word "automation", because "a brief at seven" is a thing a
person can picture. The memory cell ends on Obsidian and git, because the file being openable is what
makes the promise checkable.

### 3. Setup

> ## Three steps to a working assistant.
>
> No terminal at any point. The installer does the parts that need an API, and hands you the parts
> that need your phone.

| Step | Copy |
| --- | --- |
| Open two accounts | A Hetzner account for the server, and a Cloudflare account with a domain on it. Both are free to open and both stay in your name. You also choose the single email address that is allowed to open your console later. |
| Run the installer | The installer is a page you put on your own Cloudflare account. You paste a token, it creates an address only you can open, and it starts a server with the assistant already on it. Your tokens are used once, in your own browser, and are never written down. Boot takes three to five minutes. |
| Scan the QR with WhatsApp | Link your phone the same way you link WhatsApp Web. Then sign in to Claude, connect Google if you want it, and pick which routines run. Each screen tells you what it is about to do before it does it. |

**Why.** The headings are verbs, not "Step 1 / Step 2 / Step 3". The domain requirement is stated in
step one rather than discovered in step two, because it is the one thing that can stop a person.

**This is the rev 3 wording.** If the hosted model returns, step one becomes:

> **Sign up with your email.** A six digit code arrives by mail. There is no password to choose and
> no Google account to connect. That email becomes the only address allowed to open your console.

and step two becomes:

> **The site builds your server.** You paste a Hetzner token from your own account. The site opens a
> server, installs the assistant and puts a private front door in front of it. The token is used
> once, in that one request, and never stored. Boot takes three to five minutes.

### 4. The console

> ## You can see what it is doing.
>
> A web page on your own server shows whether WhatsApp is linked, which routines ran and what they
> cost, and anything that is waiting for you to say yes.

The panel footer carries the rule that matters: "Approval happens in WhatsApp. The console never
sends anything on your behalf."

### 5. What stays yours

> ## Your messages never leave your server.
>
> WhatsApp history, mail, media and every token sit on the machine you rent. Nothing is copied off
> it. There is no service in the middle and no database anywhere holding your data.

The amber block, which is the safety promise:

> ### It cannot message another person without your yes.
>
> Anything that would reach someone else stops first. A WhatsApp message, an email, a calendar invite
> with guests. It shows you the draft with a short code, and nothing leaves until you type that code
> back.
>
> `It would send:` **`yes k3f9qa`**

Then the honest pair:

| Panel | Copy |
| --- | --- |
| Nothing is stored anywhere else | The installer runs on your own Cloudflare account and talks to Hetzner with your token, from your browser. It keeps no database and writes nothing down. Once you are set up, the only copy of anything is the one on your server. |
| The one thing worth knowing | The first boot instructions carry your deploy key and tunnel token, and Hetzner can read them while the server starts. Every cloud server is built this way. The server deletes its copy as soon as it has finished booting. |

**Why.** A privacy section with no cost is not believable. Under rev 3 the real cost is the cloud-init
payload, which the plan flags under "Security, stated once", so that is what the page names.

**This is the rev 3 wording.** If the hosted model returns, the pair becomes:

| Panel | Copy |
| --- | --- |
| Hosted address (default) | Your console gets a name under my domain, and my Cloudflare account is the front door. That account can see that you opened the console. It cannot see your messages, your mail or your tokens. Those never travel through it. |
| Your own Cloudflare | Give the setup a token for a domain you own, and the front door is built on your account instead. After setup nothing of yours passes through me at all. |

### 6. Cost

> ## Two bills, both in your name.
>
> You open both accounts yourself, in your own name, and you can close either one at any time.

| | |
| --- | --- |
| **€8.49** a month · The server | A Hetzner CX33 in Germany or Finland. Four cores, 8 GB of memory, 80 GB of disk. Before tax, and add €0.50 if you want an IPv4 address. |
| **Your plan** · Claude | Sign in on the server with the Claude subscription you already pay for, or use an API key and watch the daily spend in the console. |

**Price verified 2026-09-03.** CX33 is €8.49 per month excluding VAT, the price that took effect on
15 June 2026, up from €6.49. A Cloud Primary IPv4 is €0.50 per month extra, also excluding VAT. The
CX series exists only in Germany (FSN1, NBG1) and Finland (HEL1); the US regions have no CX plans.
Sources: `docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/` and
`.../ipv4-pricing/`, with specs from `hetzner.com/cloud/cost-optimized/`.

Third-party blogs disagree about this number because they were written on either side of the June
increase. If the page sits unedited for a long time, this is the one figure that will go stale.

### 7. Who it is for

> ## Built for one person.
>
> One phone, one server, one person's history. It is not a shared inbox, it is not a help desk, and
> it will not answer your customers.
>
> If you need something that talks to other people on its own, this is the wrong tool and you should
> not set it up.

**Why.** The plan's non-goals say this outright, and telling the wrong person to leave is cheaper than
supporting them later.

### 8. Closing

> ## It takes about ten minutes.
>
> You need a Hetzner account, a domain on Cloudflare and the phone your WhatsApp is on. Everything
> else happens on the page.
>
> **Start setup**

Ten minutes is the plan's own acceptance criterion, not a marketing number.

---

## Verification

- **Zero em-dashes and zero en-dashes** in the HTML and the CSS. Checked mechanically.
- **Contrast.** Every foreground and background pair, including the three opacity-blended ones, was
  computed against WCAG AA. All pass in both themes. Two failures were found and fixed: the light
  button green was 4.29 against white, so buttons now use a darker `--btn-bg` at 5.33; and the amber
  used for the confirm token was 3.80 on white, so text amber is now a separate `--warn-ink` token at
  5.94 while borders keep the original hue.
- **Hero.** Two headline lines, 18 words of subtext, both buttons above the fold at 1280x800.
- **Eyebrows.** Zero above section headlines. The uppercase micro-labels that exist are inside the
  console preview and the cost figures, where they label a value rather than a section.
- **Layout families.** Split hero, bento, definition rows, split preview, paired panels, figure
  strip, editorial block, closing band. No family repeats, and no row of three equal cards.
- **Themes and widths.** Rendered and read at 1200px light, 1200px dark and 390px light.
- **No scroll cues, no version labels, no locale strips, no decorative dots, no marquees.**

## Follow-up the site owner has to close

`Start setup` points at `/install`. That route does not exist yet. It should serve the hand-over to
`apps/installer`, which under rev 3 means the deploy instructions in `docs/INSTALLER.md`. Until it
exists the page's only call to action is a dead link.
