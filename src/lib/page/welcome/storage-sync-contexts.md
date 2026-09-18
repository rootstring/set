## Storage

In the browser, your notes are saved in this browser only. They're still there when you close the tab, but they aren't on any other browser or device, and clearing the browser's data deletes them.

To keep a copy, or to move to another browser, open **Settings → Storage** and choose **Export**. In the other browser, choose **Import** in the same place.

In the desktop app, every page is a Markdown file in a folder on your computer, `Documents/Set` unless you choose another.

Any app can open those files, and Set picks up changes made outside of it.

## Sync

The desktop app syncs your notes between your devices. There's no server and no account, so your notes are never stored anywhere but on your devices.


> [!NOTE]
> The sync is not real-time for now. You have to trigger it manually and have both devices open and connected to the internet during the sync.


Set shows you a diff view of the changes before you sync. Changes in different parts of the same note are merged. If they overlap, both versions are kept, the older one as a copy marked as a conflict. Sync isn't available in the browser.

## Contexts

Contexts are workspaces that let you separate your notes. Each context has a page tree of its own, and the sidebar shows one context at a time.

You're in **{{context}}** now.

### Switching

- Click the context name at the top of the sidebar and pick another.
- Press {{desktopContextKeys}} in the desktop app, or {{webContextKeys}} in the browser, to jump straight to one, in the order they're listed. The browser keeps {{desktopContextKeys}} for its own tabs.
- Open the quick switcher ({{quickSwitcher}}) and type a context's name.

### Creating

Click the context name, then the **+** button.

Rename, reorder or delete contexts in **Settings → Contexts**. A deleted context goes to Trash with all of its pages, and can be restored from there.

### Moving pages

Open a page's menu (the **•••** at the top right) and choose **Move to context**. Its sub-pages move with it.

### On disk

In the desktop app, each context is a folder at the top of your notes folder, and each page is a Markdown file inside it:

```
Set/
  Welcome to Set (beta).md
  Welcome to Set (beta)/
    Storage, Sync and Contexts.md
Work/
  Roadmap.md
```

A folder you make there yourself also shows up as a context.
