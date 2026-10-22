"""Visible screen reconstruction for the ANSI operations used by Pi PTY tests."""
import re, unicodedata

# Interpret the cursor/erase operations emitted by the fullscreen renderer, so an
# old raw-output match cannot pass after the mode label has disappeared.
def visible_rows(raw, rows=30, columns=110):
    # The terminal displays synchronized frames atomically. Ignore a partial
    # frame when a PTY read splits an ANSI sequence or a UTF-8 character.
    end = raw.rfind(b'\x1b[?2026l')
    if end >= 0: raw = raw[:end + len(b'\x1b[?2026l')]
    screen = [[' '] * columns for _ in range(rows)]; row = col = 0
    for match in re.finditer(r'\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[([0-?]*)([ -/]*)([@-~])|\x1b[=>]|[\s\S]', raw.decode(errors='replace')):
        token = match.group(0)
        if match.group(3):
            code = match.group(3); private = match.group(1).startswith('?')
            if match.group(1).startswith(('>', '<', '=')): continue
            args = [int(x) if x else 0 for x in match.group(1).lstrip('?').split(';')]
            n = args[0] or 1
            if private:
                if args[0] == 1049 and code == 'h': screen = [[' '] * columns for _ in range(rows)]; row = col = 0
            elif code in ['H', 'f']: row = min(rows - 1, n - 1); col = min(columns - 1, (args[1] if len(args) > 1 and args[1] else 1) - 1)
            elif code == 'A': row = max(0, row - n)
            elif code == 'B': row = min(rows - 1, row + n)
            elif code == 'C': col = min(columns - 1, col + n)
            elif code == 'D': col = max(0, col - n)
            elif code == 'G': col = min(columns - 1, n - 1)
            elif code == 'K':
                a, b = (0, columns) if args[0] == 2 else (0, col + 1) if args[0] == 1 else (col, columns)
                screen[row][a:b] = [' '] * (b - a)
            elif code == 'J':
                if args[0] in [2, 3]: screen = [[' '] * columns for _ in range(rows)]
                elif args[0] == 0:
                    screen[row][col:] = [' '] * (columns - col)
                    for y in range(row + 1, rows): screen[y] = [' '] * columns
            continue
        if token.startswith('\x1b'): continue
        if token == '\r': col = 0
        elif token == '\n':
            row += 1
            if row >= rows: screen.pop(0); screen.append([' '] * columns); row = rows - 1
        elif token == '\b': col = max(0, col - 1)
        elif ord(token) >= 32:
            width = 0 if unicodedata.combining(token) else 2 if unicodedata.east_asian_width(token) in ['W', 'F'] else 1
            if col + width > columns:
                col = 0; row += 1
                if row >= rows: screen.pop(0); screen.append([' '] * columns); row = rows - 1
            if width:
                screen[row][col] = token
                if width == 2: screen[row][col + 1] = ''
                col += width
    return [''.join(line).rstrip() for line in screen]
