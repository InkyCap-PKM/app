#import "/.inkycap/notebox.typ": *

#note(
  title: "Collaboration",
  description: "How to work with others on a shared notebox in InkyCap: live Git sync or offline package exchange, the merge-first model, reviewing changes, and giving feedback.",
  tags: ("documentation",),
  aliases: ("Collaboration",),
)

= Collaboration

InkyCap provides basic collaboration functionality (not real time). You can share a notebox with collaborators so that your edits and theirs blend together automatically but you stay in control of what changes. This page explains how to turn collaboration on, the two ways to share, and how to review what comes in.

#callout("important")[
  Collaboration is still a somewhat *experimental* feature. You might meet some rough edges.

InkyCap does not provide advanced collaboration functionality. The current features might be sufficient for a couple people or more but are unlikely to satisfy your workflow with a team of many collaborators. Additionally, if you make many rapid changes back-and-forth you will be better served with real time Typst collaboration such as the system provided by #link("https://typst.app/").
]

== How collaboration works

A few ideas make everything else easier to understand.

- *You share a whole notebox, not single notes.* When a notebox is collaborative, _everything_ in it is shared. If you want some notes to stay private, keep them in a separate notebox. See #wikilink("3 - Setting Up Your Notebox") for how to organize multiple noteboxes.
- *Collaboration is opt-in, one notebox at a time.* It is never a global, all-or-nothing switch.
- InkyCap keeps a history of every version, so changes that you disagree with can be reverted afterward.

=== The merge-first idea (remember this!)

InkyCap follows a _merge-first_ approach, which is at the heart of the collaboration functionality:

+ When you pull in updates, InkyCap *merges them right away*. It will not ask you to untangle a clash in the middle of your work.
+ Where your edit and a collaborator's edit touch the *same lines*, InkyCap keeps *your collaborator's* version and flags the note for you, in case you would like to revert the change or compare your change with your collaborator's.
+ *You review and revert afterward, at your own pace.* Because the full history is kept, anything you want back is a click away.

The workflow is: changes enter cleanly, the rare overlap accepts your collaborator's wording, and then you look over what arrived and undo anything you'd rather keep your way. No "resolve this conflict now" prompts.

#callout("note")[
  InkyCap does *not* check for your collaborators' updates on its own. This is by design. Your notebox stays quietly local for you until _you_ ask for updates by pressing *Sync* or *Check for updates*.
]

== The two ways to share

You pick one of these with a single toggle when you set things up. Both behave the same once you're working (same merging, same review, same history).

- *Online sync*. Your notebox connects to a shared repository on a hosting service (such as Codeberg.org, GitHub, or another git server of your choice). Everyone syncs to the same online copy. Best for ongoing, back-and-forth collaboration. #highlight[Be conscientious about *privacy considerations* and ensure that you or your collaborators configure the online repository appropriately].
- *Offline package handoff*. There's no server at all. You export the whole notebox to a single file (a `.zip`), transfer it however you like, and merge a collaborator's file back in when they return it. Best when you don't want, or can't use, an online git server, or require more privacy safeguards. 

== Turning collaboration on

You enable collaboration per notebox under *Settings › Notebox Management*. For more about the Settings window, see #wikilink("2 - Settings").

+ Open *Settings* and find the *Notebox Management* section.
+ Locate your notebox in the list. Its row has a *Collaboration* toggle (with a handshake icon).
+ Switch the toggle *on*. This opens the notebox and shows the *Collaboration via Git* setup form.
+ Fill in the form (below) and choose *Set up collaboration*.

Once it's on, a *Configure* button appears beside the toggle so you can return to the settings any time.

=== The setup form

The form asks for a few things:

- *Offline (manual notebox exchange)*. Leave this off for online sync; turn it on for the file-based package transfer. You can switch to an online server later if you start offline.
- *Repository address*. The web address of the shared repository (for online sync), for example an `https://` link your collaborator gives you.
- *Username* and *Password*. Your sign-in for the hosting service.
- *Branch*. Leave this as the default, `main`, unless you specifically change it on the git server you use.
- *Your name and e-mail address*. A *label* shown on your changes so collaborators can see who made each edit. This is just a label, not a login. InkyCap pre-fills it if you already have a name set up.

#callout("tip")[
  Some services (like GitHub, or any account with two-step verification) need a special "app password" you create in that service's security settings, rather than your normal login password. Your password is managed and stored in your operating system's keychain. It is never kept inside the notebox itself.
]

#callout("tip", title: "Advanced configurations")[
  There's an *Advanced* "Connect with SSH instead" toggle that signs in using your machine's existing SSH keys instead of a username and password; choose it only if you already use SSH with this service. The connection details (remote and branch) live per-machine in `.inkycap/local.json`, _not_ in the shared `settings.json`. The author label falls back to your system `git config` `user.name` / `user.email`, which is why commits can show a system name. That's expected. 

The "`Bundle Typst packages on share`" toggle (off by default) includes any extra installed Typst packages into the notebox so collaborators can compile offline; `@preview` packages download per-person automatically.
]

== Joining someone else's collaborative notebox

If a collaborator set things up and invited you, you join from *Settings › Notebox Management* using one of two buttons at the top of the notebox list:

- *Clone from remote*. Join an online collaborative notebox. Enter the address they gave you, choose an *empty* folder on your computer to hold the notebox, and select *Clone & open*. The notebox arrives ready to collaborate.
- *Import package*. Turn a `.zip` package someone sent you into a new notebox. Pick the file and an empty destination folder, then choose *Import & open*.

#callout("note")[
  Because connection details are kept per-computer, a freshly cloned notebox may open as _not_ collaborative until you reconnect. When that happens, the Collaboration pane offers a one-click *Reconnect collaboration* button that adopts the existing link with no typing.
]

== How to access the collaboration features

Collaboration lives in a panel in the *left sidebar*. You can open it from:

- The *status-bar chip* at the bottom of the window (a handshake icon with a short status summary), which appears _only on noteboxes that have collaboration enabled_.
- The *Configure* button in Settings › Notebox Management.
- The *command palette*, under the "Collaboration" category.

== Online sync (everyday use)

In the panel's *Sync changes* section you'll find two buttons:

- *Sync* is the main action. It brings in your collaborators' changes, merges them, and shares yours back, all in one step. When it finishes you'll see a brief message such as "Synced (3 notes changed)", "Already up to date", or "Your changes are shared".
- *Check for updates* is a peek-only action. It tells you whether anything new is waiting ("2 updates available. Sync to get them") *without* changing anything in your notebox. Use it when you just want to know if a collaborator has made changes.

The panel also shows a short status line (for example "No local changes" when you're up to date, "Changes to share" when you have work to send, or "2 incoming") and a "Files you'll share" preview so you can see exactly what an upcoming sync will carry.

== Offline package handoff (everyday use)

When you chose the *Offline* mode, the panel shows *Import/export changes* instead, with:

- *Export package* writes your whole notebox to a `.zip` file you can send to a collaborator.
- *Import package* merges a `.zip` a collaborator sent you back into your notebox, using the same merge-first behaviour as online sync.
- An optional *Archive password*. Leave it blank for no encryption, or set one to encrypt the package (AES-256). Share that password separately. 

#callout("danger")[
  Like any password-enabled functionality in InkyCap, *InkyCap does not store the password*. If you set an archive password and then lose it, the package cannot be opened. Keep your password somewhere safe and share it with collaborators through a separate channel. The same export password unlocks the package on import.
]

Offline handoff is a manual peer-to-peer sync (same merging, same review tools, same version history). The only things unique to online mode are the address, username, password, and SSH connection fields.

== Reviewing what came in

After every Sync or package import, the Collaboration panel gives you a clear picture of what changed.

=== Files changed from last sync

This is your main "what just arrived" list. It names every note the last sync folded changes into. For each note you can:

- *Click the row* to open the note and reveal its Changes view.
- *Revert* that whole note back to your version from before the sync, using the revert (circular arrow) icon.

Notes where a collaborator's edit overlapped yours carry a clear badge ("collision: accepted collaborator's version") and sort to the top so they're easy to spot and double-check. A note that also has open suggestions shows "_N_ suggestion(s) await feedback".

#callout("note")[
  This list is a running record of what changed since your last sync, not a to-do list to clear. Reverting a note doesn't erase it from the list; the list simply refreshes the next time you sync.
]

=== The per-note Changes view

Open any reviewed note and the right sidebar's *Changes & History* pane shows two parts:

- *Incoming since last sync* shows your collaborator's changes. You can jump to each change in the note, revert a single change, or *Revert all* to restore your whole pre-sync version.
- *Local activity since last sync* shows your own recent edits, for reference.

=== Changes to resolve

Separately, the panel keeps a *Changes to resolve* list: notes that contain suggestions intentionally inserted and waiting for your accept-or-reject decision (covered next). Your own suggestions aren't counted here. Only ones from others awaiting your call appear.

== Giving feedback: suggestions and annotations

Alongside sharing, InkyCap gives you two gentle ways to comment on a draft without overwriting it. These are manual tools you reach for whenever you like and they're included in the synchronization process. 

- *Annotations* are visible _comments_ (a remark or question that doesn't change the text). They appear as a tinted callout beside the content. These are different from the inline Typst comments that begin with `//` and are not visible in an output. 
- *Suggestions* are proposed _changes_ that stay marked as pending until someone accepts or rejects them. There are three kinds: suggest an insertion, a deletion, or a replacement.

You add either one to the text you've selected, using the command palette (under the "Edit" category) or the buttons at the bottom of the Changes pane:

- *Add Annotation*
- *Suggest Insertion*
- *Suggest Deletion*
- *Suggest Replacement*

To act on a suggestion, click it (in the visual editor it appears as a small pill) to open an *Accept* / *Reject* menu, where you can also leave a comment for the author.

#callout("important")[
  Accepting or rejecting a suggestion cleans it out of the text entirely. An accepted insertion becomes ordinary writing, and a rejected one disappears. This means a finished document you publish or export *never* carries leftover suggestion marks. See #wikilink("3 - Exporting and Publishing").
]

== Version history and restoring

Every collaborative note keeps its full history. In the *Changes & History* pane, switch from *Changes* to *History* to see earlier versions, newest first (the current one is badged "current").

For any past version you can:

- *Restore* it. This brings the older content back as a _new_ change you can then sync. It's non-destructive: earlier versions stay in history, and nothing is overwritten permanently.
- *Compare* it. This opens a read-only side-by-side of that version against the current note, where you can restore the whole note or just one chunk.
- *Open beside* to view the old version in a split next to your current note.

If a sync ever kept a collaborator's version over one of yours, the relevant entry is badged "your previous version (replaced by last sync)", so you can always find and restore exactly what you had written.

#callout("note")[
  Version histories are a function of collaboration and only appear once the notebox is set up for collaboration. Until then, the History tab will point you to Settings › Notebox Management to turn collaboration on.
]

== Stopping or adjusting collaboration

In the Collaboration panel, the *Manage collaboration* section lets you edit any of your setup details later (address, branch, sign-in, identity, and the online/offline mode) and save them with one button. Leave the password blank to keep the one you already saved.

To stop entirely, choose *Stop collaborating*. This only removes InkyCap's collaboration link. Your files and their history stay on your local computer. There's an optional checkbox to also delete the version history to reclaim disk space, which cannot be undone.

== Keyboard shortcuts

A few collaboration actions have shortcuts (see #wikilink("3 - Keyboard Shortcuts") for the full list):

- *Sync*: Ctrl+Shift+S
- *Check for updates*: Ctrl+Shift+U
- *Export package*: Ctrl+Shift+E (offline mode)
- *Import package*: Ctrl+Shift+G (offline mode)

If you run a command in the wrong mode (for example, Export while in online mode), InkyCap simply explains what to do instead rather than acting.

== Related pages

- #wikilink("3 - Setting Up Your Notebox")
- #wikilink("2 - Settings")
- #wikilink("2 - Editing Notes")
- #wikilink("3 - Exporting and Publishing")
- #wikilink("3 - Keyboard Shortcuts")
