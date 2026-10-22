"""Inline model authentication through the real CLI/PTY, using only local fixtures."""
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
from pathlib import Path

from terminal_screen import visible_rows
from team_fixture import team_config

ROOT = Path(__file__).resolve().parents[2]
CLI = Path(os.environ.get("COTHINK_TEST_CLI", str(ROOT / "bin/cothink.js")))
NEW_SECRET = "sk-inline-fixture-only-73e42"
SAVED_SECRET = "sk-existing-fixture-only-a2601"


class Session:
    def __init__(self, home):
        self.home = home
        self.rows, self.columns = 24, 80
        self.master, self.slave = pty.openpty()
        self.original = termios.tcgetattr(self.slave)
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ,
                    struct.pack("HHHH", self.rows, self.columns, 0, 0))
        env = dict(os.environ)
        for key in list(env):
            if any(token in key.upper() for token in ["API_KEY", "TOKEN", "SECRET", "ACCESS_KEY", "CREDENTIAL", "AWS_"]):
                env.pop(key, None)
        env.pop("COTHINK_NO_TTY", None)
        env.update(COTHINK_HOME=str(home), HOME=str(home / "user"),
                   XDG_CONFIG_HOME=str(home / "user/.config"), PI_OFFLINE="1", TERM="xterm-256color")
        self.child = subprocess.Popen(["node", str(CLI)], cwd=home, stdin=self.slave,
                                      stdout=self.slave, stderr=self.slave, env=env,
                                      start_new_session=True)
        self.out = bytearray()
        self.cache = None
        self.screens, self.checks = {}, []

    def pump(self):
        if select.select([self.master], [], [], .025)[0]:
            try:
                self.out.extend(os.read(self.master, 65536))
            except OSError as error:
                if error.errno != errno.EIO:
                    raise

    def screen(self):
        key = len(self.out)
        if self.cache is None or self.cache[0] != key:
            self.cache = (key, "\n".join(visible_rows(self.out, self.rows, self.columns)))
        return self.cache[1]

    def wait(self, condition, description):
        deadline = time.monotonic() + 12
        while not condition():
            self.pump()
            assert self.child.poll() is None, "CLI exited while waiting for " + description + "\n" + self.screen()
            assert time.monotonic() < deadline, "Timed out waiting for " + description + "\n" + self.screen()

    def see(self, text):
        self.wait(lambda: text in self.screen(), repr(text))

    def send(self, text):
        os.write(self.master, text.encode())
        self.pump()

    def selected_text(self):
        return next((line.split("→", 1)[1].strip() for line in self.screen().splitlines() if "→" in line), None)

    def selected(self, text):
        self.wait(lambda: self.selected_text() == text, "selected " + repr(text))

    def pick(self, index, marker):
        self.send("\x1b[H" + "\x1b[B" * index + "\r")
        self.see(marker)

    def choose_label(self, label, marker, from_end=False):
        self.send("\x1b[F" if from_end else "\x1b[H")
        # The end item is part of the user flow and anchors provider navigation.
        if from_end:
            self.selected("自定义服务商")
        for _ in range(150):
            previous = self.selected_text()
            if previous == label:
                self.send("\r")
                if marker is not None:
                    self.see(marker)
                return
            self.send("\x1b[A" if from_end else "\x1b[B")
            self.wait(lambda: self.selected_text() != previous, "next menu option")
        raise AssertionError("Missing menu option " + repr(label) + "\n" + self.screen())

    def open_add(self):
        self.see("预算：纯答")
        self.send("\x15/models\r")
        self.see("追加副模型")
        self.pick(1, "选择模型")

    def open_providers(self):
        self.open_add()
        self.send("\x1b[F")
        self.selected("配置服务商或模型")
        self.send("\r")
        self.see("副服务商")

    def custom_prompt(self):
        self.open_providers()
        self.send("\x1b[F")
        self.selected("自定义服务商")
        self.send("\r")
        self.see("自定义配置 ID")
        self.send("inline-fixture\r")
        self.see("API 根地址")
        self.send("http://127.0.0.1:1/v1\r")
        self.see("协议")
        self.pick(0, "模型 ID")
        self.send("inline-deputy\r")
        self.api_prompt()

    def api_prompt(self):
        self.wait(lambda: re.search(r"API\s*key", self.screen(), re.I) is not None
                  and "to cancel" in self.screen(), "inline masked API key prompt")

    def type_secret(self, secret):
        self.send(secret)
        self.see("•" * len(secret))
        assert secret.encode() not in self.out, "API key was echoed in PTY output"
        self.record("native secret input masks the key")

    def auth_notice(self, action, provider):
        pattern = re.compile(re.escape(action) + r"[^\n]*" + re.escape(provider) + r"[^\n]*API\s*key", re.I)
        self.wait(lambda: pattern.search(self.screen()) is not None and "保存为新 team" in self.screen(),
                  "persistent provider-specific authentication notice")
        rows = self.screen().splitlines()
        notice = next(i for i, line in enumerate(rows) if pattern.search(line))
        roster = next(i for i, line in enumerate(rows) if "阵容编辑" in line)
        assert notice < roster, "Authentication notice must be visible before the roster summary"
        self.record("provider authentication result remains above roster menu")

    def return_to_editor(self):
        self.wait(lambda: "Esc取消" not in self.screen() and "to cancel" not in self.screen()
                  and "预算：纯答" in self.screen(), "return to task editor")

    def record(self, name):
        self.screens[name] = self.screen()
        self.checks.append(name)

    def stop(self):
        if self.child.poll() is None:
            self.child.terminate()
        deadline = time.monotonic() + 5
        while self.child.poll() is None and time.monotonic() < deadline:
            self.pump()
        try:
            assert self.child.poll() is not None, "CLI did not exit after SIGTERM"
            assert termios.tcgetattr(self.slave) == self.original, "CLI did not restore terminal settings"
        finally:
            if self.child.poll() is None:
                self.child.kill()
                self.child.wait()
            os.close(self.master)
            os.close(self.slave)


def make_fixture(home):
    (home / "pi").mkdir()
    (home / "user/.config").mkdir(parents=True)
    ref = lambda name: dict(provider="fixture", modelId=name)
    config = team_config(dict(formatVersion=2, main=ref("main"), secondary=[ref("reviewer")]), "Original")
    (home / "config.json").write_text(json.dumps(config, indent=2) + "\n")
    def provider(ids):
        return dict(api="openai-completions", baseUrl="http://127.0.0.1:1/v1", models=[
            dict(id=name, name=name, reasoning=False, input=["text"], contextWindow=32000,
                 maxTokens=4096, cost=dict(input=0, output=0, cacheRead=0, cacheWrite=0)) for name in ids])
    catalog = dict(providers={"fixture": provider(["main", "reviewer", "extra"]),
                              "unauth-fixture": provider(["unauth-deputy"])})
    (home / "pi/models.json").write_text(json.dumps(catalog, indent=2) + "\n")
    (home / "pi/auth.json").write_text(json.dumps({"fixture": {"type": "api_key", "key": SAVED_SECRET}}, indent=2) + "\n")
    return config, catalog


def snapshot(home):
    return {name: (home / name).read_bytes() if (home / name).exists() else None
            for name in ["config.json", "pi/auth.json", "pi/models.json"]}


def unchanged(home, before, names=None):
    after = snapshot(home)
    for name in names or before:
        assert after[name] == before[name], name + " unexpectedly changed"


def assert_no_generation(home):
    for name in ["requests", "tasks"]:
        assert not list((home / name).rglob("*.json")), "Model management created " + name


def save_new_team(s, home, original, expected):
    # Authentication and roster edits do not silently replace the active Team.
    assert json.loads((home / "config.json").read_text()) == original
    s.pick(4, "新 team 名称")
    assert "原 team 保留" in s.screen()
    s.send("Added deputy\r")
    s.see("从下一条任务生效")
    saved = json.loads((home / "config.json").read_text())
    assert len(saved["teams"]) == 2
    assert saved["teams"][0] == original["teams"][0]
    added = saved["teams"][1]
    assert added["name"] == "Added deputy"
    assert added["main"] == original["teams"][0]["main"]
    assert added["secondary"] == original["teams"][0]["secondary"] + [expected]
    assert saved["lastUsedTeamId"] == added["id"]
    s.record("explicit save adds a new Team and preserves the original")


def check_reuse(s, home, original, catalog):
    before = snapshot(home)
    s.open_add()
    # An unauthenticated provider remains reachable through configuration, not
    # falsely advertised as ready in the existing authenticated-model list.
    assert "unauth-fixture/unauth-deputy" not in s.screen()
    s.choose_label("fixture/extra", "保存为新 team")
    s.auth_notice("将复用", "fixture")
    unchanged(home, before)
    assert SAVED_SECRET.encode() not in s.out
    s.send("\x1b")
    s.return_to_editor()
    unchanged(home, before)
    # A notify outside the dismissed overlay must also explain the reuse.
    assert re.search(r"将复用[^\n]*fixture[^\n]*API\s*key", s.screen(), re.I), s.screen()
    s.record("existing credentials and catalog are byte-identical after cancel")


def check_custom_save(s, home, original, catalog):
    before = snapshot(home)
    s.custom_prompt()
    unchanged(home, before)
    s.type_secret(NEW_SECRET)
    unchanged(home, before)
    s.send("\r")
    s.auth_notice("已保存", "inline-fixture")
    stored = json.loads((home / "pi/auth.json").read_text())
    assert stored == {"fixture": {"type": "api_key", "key": SAVED_SECRET},
                      "inline-fixture": {"type": "api_key", "key": NEW_SECRET}}
    current_catalog = json.loads((home / "pi/models.json").read_text())
    assert {key: current_catalog["providers"][key] for key in catalog["providers"]} == catalog["providers"]
    added = current_catalog["providers"]["inline-fixture"]
    assert added["baseUrl"] == "http://127.0.0.1:1/v1"
    assert added["api"] == "openai-completions"
    assert [model["id"] for model in added["models"]] == ["inline-deputy"]
    assert NEW_SECRET not in (home / "pi/models.json").read_text()
    save_new_team(s, home, original, dict(provider="inline-fixture", modelId="inline-deputy"))
    assert NEW_SECRET.encode() not in s.out
    s.record("custom provider credentials are saved only after secret submission")


def check_custom_cancel(s, home, original, catalog, blank):
    before = snapshot(home)
    s.custom_prompt()
    unchanged(home, before)
    if blank:
        s.send("   \r")
    else:
        s.type_secret(NEW_SECRET)
        s.send("\x1b")
    s.see("保存为新 team")
    assert "inline-fixture/inline-deputy" not in s.screen(), s.screen()
    if blank:
        assert "API key 不能为空" in s.screen() and "未保存认证" in s.screen(), s.screen()
    s.record("secret cancellation returns to the unchanged roster")
    unchanged(home, before)
    s.send("\x1b")
    s.return_to_editor()
    unchanged(home, before)
    assert NEW_SECRET.encode() not in s.out
    s.record("blank secret cancels without changing config/auth/catalog" if blank
             else "Escape cancels without changing config/auth/catalog")


def check_existing_save(s, home, original, catalog):
    before = snapshot(home)
    s.open_providers()
    s.choose_label("unauth-fixture", None, from_end=True)
    s.api_prompt()
    unchanged(home, before)
    s.type_secret(NEW_SECRET)
    s.send("\r")
    s.see("副模型")
    s.choose_label("unauth-deputy", "保存为新 team")
    s.auth_notice("已保存", "unauth-fixture")
    unchanged(home, before, ["pi/models.json"])
    stored = json.loads((home / "pi/auth.json").read_text())
    assert stored == {"fixture": {"type": "api_key", "key": SAVED_SECRET},
                      "unauth-fixture": {"type": "api_key", "key": NEW_SECRET}}
    save_new_team(s, home, original, dict(provider="unauth-fixture", modelId="unauth-deputy"))
    assert NEW_SECRET.encode() not in s.out
    s.record("existing unauthenticated provider authenticates inline without catalog rewrite")


CASES = {
    "reuse": check_reuse,
    "custom-save": check_custom_save,
    "custom-escape": lambda *args: check_custom_cancel(*args, blank=False),
    "custom-blank": lambda *args: check_custom_cancel(*args, blank=True),
    "existing-save": check_existing_save,
}


def run_case(name):
    with tempfile.TemporaryDirectory(prefix="cothink-inline-auth-") as folder:
        home = Path(folder)
        original, catalog = make_fixture(home)
        s = Session(home)
        try:
            s.see("预算：纯答")
            CASES[name](s, home, original, catalog)
            assert_no_generation(home)
            s.checks.append("management created zero tasks or requests")
            return dict(case=name, checks=s.checks, screens=s.screens)
        finally:
            s.stop()


if __name__ == "__main__":
    names = sys.argv[1:] or list(CASES)
    print(json.dumps([run_case(name) for name in names], ensure_ascii=False, indent=2))
