# Runs a harness scenario in an offscreen WebKitGTK window and prints its
# result. Usage: python3 harness/drive.py '<js expression returning a promise>'
# The expression's resolved value is JSON-stringified and printed.
import gi, sys, json, threading, http.server, socketserver, os
gi.require_version('Gtk', '3.0'); gi.require_version('Gdk', '3.0'); gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, Gdk, WebKit2, GLib

DIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist")
class Quiet(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=DIST, **k)
    def log_message(self, *a): pass
socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(("127.0.0.1", 0), Quiet)
port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()

expr = sys.argv[1]
win = Gtk.OffscreenWindow()
wv = WebKit2.WebView()
wv.get_settings().set_enable_write_console_messages_to_stdout(True)
win.add(wv); win.set_default_size(900, 600); win.show_all(); wv.grab_focus()

KEYVALS = {"Home": Gdk.KEY_Home, "End": Gdk.KEY_End, "ArrowLeft": Gdk.KEY_Left, "ArrowUp": Gdk.KEY_Up, "x": Gdk.KEY_x}

def send_real_key(name):
    """Deliver a real key press and release to the web view, as the keyboard
    would, so the browser's default actions run too."""
    keymap = Gdk.Keymap.get_for_display(Gdk.Display.get_default())
    ok, keys = keymap.get_entries_for_keyval(KEYVALS[name])
    for et in (Gdk.EventType.KEY_PRESS, Gdk.EventType.KEY_RELEASE):
        ev = Gdk.Event.new(et)
        ev.window = wv.get_window()
        ev.send_event = True
        ev.time = Gdk.CURRENT_TIME
        ev.keyval = KEYVALS[name]
        ev.hardware_keycode = keys[0].keycode if ok and keys else 0
        ev.state = 0
        wv.event(ev)

def poll_done(obj, res):
    try:
        v = wv.evaluate_javascript_finish(res).to_string()
    except Exception as e:
        print("JS error:", e); Gtk.main_quit(); return
    if v.startswith("KEY:"):
        send_real_key(v[4:])
        wv.evaluate_javascript("window.__wantKey = ''; window.__keyDone = true; ''", -1, None, None, None, lambda o, r: GLib.timeout_add(50, poll))
        return
    if v:
        print(v); Gtk.main_quit()
    else:
        GLib.timeout_add(100, poll)

def poll():
    wv.evaluate_javascript("window.__wantKey ? 'KEY:' + window.__wantKey : (window.__result || '')", -1, None, None, None, poll_done)
    return False

def loaded(view, ev):
    if ev == WebKit2.LoadEvent.FINISHED:
        js = ("window.__result = ''; (async () => { try { const r = await (%s); window.__result = JSON.stringify(r); }"
              " catch (e) { window.__result = 'ERR ' + (e && (e.message + ' | ' + e.stack) || e); } })(); ''") % expr
        def start():
            wv.evaluate_javascript(js, -1, None, None, None, lambda o, r: GLib.timeout_add(150, poll))
            return False
        GLib.timeout_add(300, start)

wv.connect("load-changed", loaded)
wv.load_uri("http://127.0.0.1:%d/" % port)
GLib.timeout_add(25000, Gtk.main_quit)
Gtk.main()
