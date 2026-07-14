from __future__ import annotations

import json
import os
import queue
import re
import shlex
import signal
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

APP_VERSION = "0.1.0"
QUALITIES = (
    "MP4_128", "MP4_128_DUAL", "MP4_256", "MP4_256_DUAL",
    "OGG_VORBIS_320", "OGG_VORBIS_160", "OGG_VORBIS_96",
)
SPOTIFY_INPUT_RE = re.compile(
    r"^(?:https?://open\.spotify\.com/(?:intl-[a-z]{2}/)?"
    r"(?:track|album|playlist|show|episode)/[A-Za-z0-9]+(?:\?.*)?"
    r"|spotify:(?:track|album|playlist|show|episode):[A-Za-z0-9]+"
    r"|[A-Za-z0-9]{16,32})$", re.I,
)

I18N = {
    "bg": {
        "title": "DyrakArmy – Spotify OGG/MP4 двигател",
        "engine": "Външен двигател",
        "script": "Път до main.py:",
        "python": "Python команда:",
        "browse": "Избери",
        "check": "Провери",
        "open": "Отвори папката",
        "job": "Задача",
        "input": "Spotify URL / URI / ID:",
        "quality": "Качество:",
        "output": "Изходна папка:",
        "debug": "Debug логове",
        "start": "Стартирай",
        "stop": "Спри",
        "clear": "Изчисти",
        "language": "Език:",
        "ready": "Готово.",
        "running": "Работи…",
        "bad_input": "Въведи валиден Spotify URL, URI или ID.",
        "bad_script": "Избраният main.py не съществува.",
        "bad_python": "Python командата е празна.",
        "bad_output": "Изходната папка не може да бъде създадена.",
        "active": "Вече има активна задача.",
        "confirm": "Има активна задача. Да бъде ли прекратена?",
        "check_ok": "Двигателят отговори успешно.",
        "check_fail": "Проверката завърши с грешка.",
        "done": "Задачата завърши успешно.",
        "failed": "Задачата приключи с код {code}.",
        "stopped": "Задачата беше прекратена.",
        "setup": (
            "Липсва config.json. Направи първоначалната настройка на двигателя "
            "в негов терминал. GUI не записва cookies или пароли."
        ),
        "notice": (
            "Стартира отделно инсталирано копие на spotify-oggmp4-dl. "
            "Не включва и не настройва CDM, PlayPlay, ключове или удостоверителни данни."
        ),
    },
    "en": {
        "title": "DyrakArmy – Spotify OGG/MP4 engine",
        "engine": "External engine",
        "script": "Path to main.py:",
        "python": "Python command:",
        "browse": "Browse",
        "check": "Check",
        "open": "Open folder",
        "job": "Job",
        "input": "Spotify URL / URI / ID:",
        "quality": "Quality:",
        "output": "Output directory:",
        "debug": "Debug logs",
        "start": "Start",
        "stop": "Stop",
        "clear": "Clear",
        "language": "Language:",
        "ready": "Ready.",
        "running": "Running…",
        "bad_input": "Enter a valid Spotify URL, URI, or ID.",
        "bad_script": "The selected main.py does not exist.",
        "bad_python": "The Python command is empty.",
        "bad_output": "The output directory could not be created.",
        "active": "A job is already running.",
        "confirm": "A job is active. Stop it?",
        "check_ok": "The engine responded successfully.",
        "check_fail": "The engine check failed.",
        "done": "The job completed successfully.",
        "failed": "The job exited with code {code}.",
        "stopped": "The job was stopped.",
        "setup": (
            "config.json is missing. Complete the engine's first-run setup in "
            "its own terminal. The GUI does not store cookies or passwords."
        ),
        "notice": (
            "Launches a separately installed copy of spotify-oggmp4-dl. "
            "It does not bundle or configure CDM, PlayPlay, keys, or credentials."
        ),
    },
}


def settings_path() -> Path:
    if sys.platform.startswith("win"):
        base = Path(os.getenv("LOCALAPPDATA") or Path.home())
    else:
        base = Path(os.getenv("XDG_CONFIG_HOME") or Path.home() / ".config")
    folder = base / "DyrakArmyDesktop"
    folder.mkdir(parents=True, exist_ok=True)
    return folder / "spotify_oggmp4_engine.json"


def default_python() -> str:
    return "py -3" if sys.platform.startswith("win") else (sys.executable or "python3")


class EngineGUI:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.geometry("860x620")
        self.root.minsize(760, 520)
        self.config_file = settings_path()
        cfg = self._load_config()

        self.lang_var = tk.StringVar(value=str(cfg.get("lang", "bg")))
        self.script_var = tk.StringVar(value=str(cfg.get("script", "")))
        self.python_var = tk.StringVar(value=str(cfg.get("python", default_python())))
        self.input_var = tk.StringVar()
        self.quality_var = tk.StringVar(value=str(cfg.get("quality", "OGG_VORBIS_320")))
        self.output_var = tk.StringVar(value=str(cfg.get("output", Path.home() / "Music")))
        self.debug_var = tk.BooleanVar(value=bool(cfg.get("debug", False)))
        self.status_var = tk.StringVar()

        self.process: subprocess.Popen[str] | None = None
        self.events: queue.Queue[tuple[str, Any]] = queue.Queue()
        self.stop_requested = False

        self._build()
        self._translate()
        self.root.protocol("WM_DELETE_WINDOW", self._close)
        self.root.after(100, self._poll_events)

    @property
    def lang(self) -> str:
        value = self.lang_var.get()
        return value if value in I18N else "bg"

    def t(self, key: str) -> str:
        return I18N[self.lang].get(key, key)

    def _build(self) -> None:
        outer = ttk.Frame(self.root, padding=12)
        outer.pack(fill=tk.BOTH, expand=True)
        outer.columnconfigure(0, weight=1)
        outer.rowconfigure(3, weight=1)

        top = ttk.Frame(outer)
        top.grid(row=0, column=0, sticky="ew", pady=(0, 8))
        top.columnconfigure(0, weight=1)
        self.title_label = ttk.Label(top, font=("Segoe UI", 15, "bold"))
        self.title_label.grid(row=0, column=0, sticky="w")
        self.lang_label = ttk.Label(top)
        self.lang_label.grid(row=0, column=1, padx=(8, 4))
        lang = ttk.Combobox(top, textvariable=self.lang_var, values=("bg", "en"), width=5, state="readonly")
        lang.grid(row=0, column=2)
        lang.bind("<<ComboboxSelected>>", lambda _e: self._translate())

        self.engine_frame = ttk.LabelFrame(outer, padding=10)
        self.engine_frame.grid(row=1, column=0, sticky="ew", pady=(0, 8))
        self.engine_frame.columnconfigure(1, weight=1)
        self.script_label = ttk.Label(self.engine_frame)
        self.script_label.grid(row=0, column=0, sticky="w", padx=(0, 8), pady=4)
        ttk.Entry(self.engine_frame, textvariable=self.script_var).grid(row=0, column=1, sticky="ew")
        self.script_browse = ttk.Button(self.engine_frame, command=self._browse_script)
        self.script_browse.grid(row=0, column=2, padx=(8, 0))

        self.python_label = ttk.Label(self.engine_frame)
        self.python_label.grid(row=1, column=0, sticky="w", padx=(0, 8), pady=4)
        ttk.Entry(self.engine_frame, textvariable=self.python_var).grid(row=1, column=1, sticky="ew")
        self.python_browse = ttk.Button(self.engine_frame, command=self._browse_python)
        self.python_browse.grid(row=1, column=2, padx=(8, 0))

        engine_actions = ttk.Frame(self.engine_frame)
        engine_actions.grid(row=2, column=0, columnspan=3, sticky="w", pady=(7, 0))
        self.check_button = ttk.Button(engine_actions, command=self._check)
        self.check_button.pack(side=tk.LEFT)
        self.open_button = ttk.Button(engine_actions, command=self._open_folder)
        self.open_button.pack(side=tk.LEFT, padx=(8, 0))
        self.notice = ttk.Label(self.engine_frame, wraplength=790, foreground="#555")
        self.notice.grid(row=3, column=0, columnspan=3, sticky="w", pady=(8, 0))

        self.job_frame = ttk.LabelFrame(outer, padding=10)
        self.job_frame.grid(row=2, column=0, sticky="ew", pady=(0, 8))
        self.job_frame.columnconfigure(1, weight=1)
        self.input_label = ttk.Label(self.job_frame)
        self.input_label.grid(row=0, column=0, sticky="w", padx=(0, 8), pady=4)
        ttk.Entry(self.job_frame, textvariable=self.input_var).grid(row=0, column=1, columnspan=2, sticky="ew")

        self.quality_label = ttk.Label(self.job_frame)
        self.quality_label.grid(row=1, column=0, sticky="w", padx=(0, 8), pady=4)
        ttk.Combobox(self.job_frame, textvariable=self.quality_var, values=QUALITIES, state="readonly").grid(
            row=1, column=1, sticky="w"
        )

        self.output_label = ttk.Label(self.job_frame)
        self.output_label.grid(row=2, column=0, sticky="w", padx=(0, 8), pady=4)
        ttk.Entry(self.job_frame, textvariable=self.output_var).grid(row=2, column=1, sticky="ew")
        self.output_browse = ttk.Button(self.job_frame, command=self._browse_output)
        self.output_browse.grid(row=2, column=2, padx=(8, 0))
        self.debug_check = ttk.Checkbutton(self.job_frame, variable=self.debug_var)
        self.debug_check.grid(row=3, column=1, sticky="w", pady=(5, 0))

        bottom = ttk.Frame(outer)
        bottom.grid(row=3, column=0, sticky="nsew")
        bottom.columnconfigure(0, weight=1)
        bottom.rowconfigure(1, weight=1)
        actions = ttk.Frame(bottom)
        actions.grid(row=0, column=0, sticky="ew", pady=(0, 8))
        self.start_button = ttk.Button(actions, command=self._start)
        self.start_button.pack(side=tk.LEFT)
        self.stop_button = ttk.Button(actions, command=self._stop, state=tk.DISABLED)
        self.stop_button.pack(side=tk.LEFT, padx=(8, 0))
        self.clear_button = ttk.Button(actions, command=self._clear)
        self.clear_button.pack(side=tk.LEFT, padx=(8, 0))
        ttk.Label(actions, textvariable=self.status_var).pack(side=tk.RIGHT)

        logs = ttk.Frame(bottom)
        logs.grid(row=1, column=0, sticky="nsew")
        logs.columnconfigure(0, weight=1)
        logs.rowconfigure(0, weight=1)
        self.log = tk.Text(logs, state=tk.DISABLED, wrap="word", font=("Consolas", 10))
        self.log.grid(row=0, column=0, sticky="nsew")
        scroll = ttk.Scrollbar(logs, command=self.log.yview)
        scroll.grid(row=0, column=1, sticky="ns")
        self.log.configure(yscrollcommand=scroll.set)

    def _translate(self) -> None:
        self.root.title(f"DyrakArmy Spotify OGG/MP4 Engine {APP_VERSION}")
        pairs = {
            self.title_label: "title", self.lang_label: "language",
            self.script_label: "script", self.python_label: "python",
            self.script_browse: "browse", self.python_browse: "browse",
            self.check_button: "check", self.open_button: "open",
            self.input_label: "input", self.quality_label: "quality",
            self.output_label: "output", self.output_browse: "browse",
            self.debug_check: "debug", self.start_button: "start",
            self.stop_button: "stop", self.clear_button: "clear",
        }
        self.engine_frame.configure(text=self.t("engine"))
        self.job_frame.configure(text=self.t("job"))
        self.notice.configure(text=self.t("notice"))
        for widget, key in pairs.items():
            widget.configure(text=self.t(key))
        if self.process is None:
            self.status_var.set(self.t("ready"))
        self._save_config()

    def _load_config(self) -> dict[str, Any]:
        try:
            data = json.loads(self.config_file.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _save_config(self) -> None:
        data = {
            "lang": self.lang, "script": self.script_var.get().strip(),
            "python": self.python_var.get().strip(), "quality": self.quality_var.get(),
            "output": self.output_var.get().strip(), "debug": bool(self.debug_var.get()),
        }
        try:
            self.config_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass

    def _browse_script(self) -> None:
        value = filedialog.askopenfilename(filetypes=(("Python", "*.py"), ("All files", "*.*")))
        if value:
            self.script_var.set(value)
            self._save_config()

    def _browse_python(self) -> None:
        value = filedialog.askopenfilename(filetypes=(("Python", "python*.exe"), ("All files", "*.*")))
        if value:
            self.python_var.set(value)
            self._save_config()

    def _browse_output(self) -> None:
        value = filedialog.askdirectory()
        if value:
            self.output_var.set(value)
            self._save_config()

    def _python_prefix(self) -> list[str]:
        raw = self.python_var.get().strip()
        if not raw:
            raise ValueError(self.t("bad_python"))
        path = Path(raw.strip('"')).expanduser()
        if path.is_file():
            return [str(path.resolve())]
        parts = shlex.split(raw, posix=not sys.platform.startswith("win"))
        if parts and len(parts) == 1:
            parts[0] = parts[0].strip('"')
        if not parts:
            raise ValueError(self.t("bad_python"))
        return parts

    def _validate(self) -> tuple[list[str], Path, Path]:
        script = Path(self.script_var.get().strip()).expanduser().resolve()
        if not script.is_file() or script.name.lower() != "main.py":
            raise ValueError(self.t("bad_script"))
        output = Path(self.output_var.get().strip()).expanduser().resolve()
        try:
            output.mkdir(parents=True, exist_ok=True)
        except Exception as exc:
            raise ValueError(self.t("bad_output")) from exc
        return self._python_prefix(), script, output

    def _check(self) -> None:
        try:
            python, script, _ = self._validate()
        except ValueError as exc:
            messagebox.showerror("DyrakArmy", str(exc))
            return
        self._launch([*python, str(script), "--help"], script.parent, checking=True)

    def _start(self) -> None:
        value = self.input_var.get().strip()
        if not SPOTIFY_INPUT_RE.fullmatch(value):
            messagebox.showerror("DyrakArmy", self.t("bad_input"))
            return
        try:
            python, script, output = self._validate()
        except ValueError as exc:
            messagebox.showerror("DyrakArmy", str(exc))
            return
        if not (script.parent / "config.json").exists():
            messagebox.showwarning("DyrakArmy", self.t("setup"))
        command = [*python, str(script), "--id", value, "--quality", self.quality_var.get(), "--output", str(output)]
        if self.debug_var.get():
            command.append("--debug")
        self._save_config()
        self._launch(command, script.parent, checking=False)

    def _launch(self, command: list[str], cwd: Path, checking: bool) -> None:
        if self.process is not None:
            messagebox.showwarning("DyrakArmy", self.t("active"))
            return
        self.stop_requested = False
        self._running(True)
        shown = subprocess.list2cmdline(command) if sys.platform.startswith("win") else shlex.join(command)
        self._event("log", f"$ {shown}")
        threading.Thread(
            target=self._worker, args=(command, cwd, checking, self.lang), daemon=True
        ).start()

    def _worker(self, command: list[str], cwd: Path, checking: bool, lang: str) -> None:
        text = I18N.get(lang, I18N["bg"])
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform.startswith("win") else 0
        startup = None
        if sys.platform.startswith("win"):
            startup = subprocess.STARTUPINFO()
            startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        try:
            self.process = subprocess.Popen(
                command, cwd=str(cwd), stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace", bufsize=1,
                creationflags=flags, startupinfo=startup,
                start_new_session=not sys.platform.startswith("win"),
            )
            assert self.process.stdout is not None
            for line in self.process.stdout:
                self._event("log", line.rstrip())
            code = self.process.wait()
            if self.stop_requested:
                message = text["stopped"]
            elif code == 0:
                message = text["check_ok"] if checking else text["done"]
            else:
                message = text["check_fail"] if checking else text["failed"].format(code=code)
            self._event("log", message)
        except Exception as exc:
            self._event("log", f"ERROR: {exc}")
        finally:
            self.process = None
            self._event("running", False)

    def _stop(self) -> None:
        process = self.process
        if process is None:
            return
        self.stop_requested = True
        try:
            if sys.platform.startswith("win"):
                subprocess.run(
                    ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
                )
            else:
                os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        except Exception:
            try:
                process.kill()
            except Exception:
                pass

    def _open_folder(self) -> None:
        path = Path(self.script_var.get().strip()).expanduser()
        folder = path.parent if path.name else path
        if not folder.exists():
            messagebox.showerror("DyrakArmy", self.t("bad_script"))
            return
        if sys.platform.startswith("win"):
            os.startfile(folder)  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(folder)])
        else:
            subprocess.Popen(["xdg-open", str(folder)])

    def _running(self, value: bool) -> None:
        self.start_button.configure(state=tk.DISABLED if value else tk.NORMAL)
        self.check_button.configure(state=tk.DISABLED if value else tk.NORMAL)
        self.stop_button.configure(state=tk.NORMAL if value else tk.DISABLED)
        self.status_var.set(self.t("running") if value else self.t("ready"))

    def _event(self, kind: str, value: Any) -> None:
        self.events.put((kind, value))

    def _poll_events(self) -> None:
        try:
            while True:
                kind, value = self.events.get_nowait()
                if kind == "running":
                    self._running(bool(value))
                elif kind == "log":
                    self.log.configure(state=tk.NORMAL)
                    self.log.insert(tk.END, str(value) + "\n")
                    self.log.see(tk.END)
                    self.log.configure(state=tk.DISABLED)
        except queue.Empty:
            pass
        self.root.after(100, self._poll_events)

    def _clear(self) -> None:
        self.log.configure(state=tk.NORMAL)
        self.log.delete("1.0", tk.END)
        self.log.configure(state=tk.DISABLED)

    def _close(self) -> None:
        if self.process is not None and not messagebox.askyesno("DyrakArmy", self.t("confirm")):
            return
        if self.process is not None:
            self._stop()
        self._save_config()
        self.root.destroy()


def main() -> None:
    root = tk.Tk()
    EngineGUI(root)
    root.mainloop()


if __name__ == "__main__":
    main()
