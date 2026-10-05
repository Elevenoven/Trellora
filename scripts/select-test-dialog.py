"""Select a fixture path only in a dialog owned by the isolated test process."""
import ctypes
import sys
import time

process_id, expected_title, fixture_path = int(sys.argv[1]), sys.argv[2], sys.argv[3]
user32 = ctypes.windll.user32
callback_type = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
user32.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
user32.GetWindowTextW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
user32.GetClassNameW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
user32.GetParent.argtypes = [ctypes.c_void_p]
user32.GetParent.restype = ctypes.c_void_p
user32.GetDlgCtrlID.argtypes = [ctypes.c_void_p]
user32.GetDlgItem.argtypes = [ctypes.c_void_p, ctypes.c_int]
user32.GetDlgItem.restype = ctypes.c_void_p
user32.IsWindowVisible.argtypes = [ctypes.c_void_p]
user32.SendMessageW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]
user32.EnumWindows.argtypes = [callback_type, ctypes.c_void_p]
user32.EnumChildWindows.argtypes = [ctypes.c_void_p, callback_type, ctypes.c_void_p]


def caption(window, class_name=False):
    value = ctypes.create_unicode_buffer(1024)
    (user32.GetClassNameW if class_name else user32.GetWindowTextW)(window, value, len(value))
    return value.value


deadline = time.monotonic() + 25
last_windows, last_edits = [], []
while time.monotonic() < deadline:
    dialogs = []

    def visit(window, _):
        owner = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(window, ctypes.byref(owner))
        if owner.value == process_id:
            last_windows.append((caption(window), caption(window, True)))
            if caption(window) == expected_title and caption(window, True) == '#32770':
                dialogs.append(window)
        return True

    last_windows = []
    user32.EnumWindows(callback_type(visit), None)
    if not dialogs:
        time.sleep(0.05)
        continue
    dialog = dialogs[0]
    edits = []
    last_edits = []

    def child_visit(window, _):
        if caption(window, True) == 'Edit' and user32.IsWindowVisible(window):
            parent = user32.GetParent(window)
            last_edits.append((user32.GetDlgCtrlID(window), user32.GetDlgCtrlID(parent), caption(parent, True)))
            if user32.GetDlgCtrlID(window) in (1148, 1152) or user32.GetDlgCtrlID(parent) == 1148:
                edits.append(window)
        return True

    user32.EnumChildWindows(dialog, callback_type(child_visit), None)
    if not edits:
        time.sleep(0.05)
        continue
    text = ctypes.create_unicode_buffer(fixture_path)
    user32.SendMessageW(edits[0], 0xC, None, ctypes.cast(text, ctypes.c_void_p))
    button = user32.GetDlgItem(dialog, 1)
    assert button, 'Isolated file dialog has no confirmation button'
    user32.SendMessageW(button, 0xF5, None, None)
    break
else:
    raise RuntimeError(f'Isolated test file dialog did not become ready: windows={last_windows!r}, edits={last_edits!r}')
