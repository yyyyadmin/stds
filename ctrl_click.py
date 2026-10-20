import ctypes, sys, time
x = int(sys.argv[1]); y = int(sys.argv[2])
u = ctypes.windll.user32
u.keybd_event(0x11, 0, 0, 0)
time.sleep(0.05)
u.SetCursorPos(x, y)
time.sleep(0.05)
u.mouse_event(0x0002, 0, 0, 0, 0)
time.sleep(0.03)
u.mouse_event(0x0004, 0, 0, 0, 0)
time.sleep(0.05)
u.keybd_event(0x11, 0, 2, 0)
print('ctrl-clicked', x, y)
