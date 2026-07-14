from __future__ import annotations

import json
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from typing import Final

APP_TITLE: Final = "DyrakArmy – Protected Inputs Demo"

# Deliberately fake placeholders. They are not accepted by the external engine,
# are never sent over the network, and are never used for cryptography.
DEMO_FIELDS: Final[dict[str, str]] = {
    "cdm_profile_path": "./demo/DEVICE_PROFILE_EXAMPLE.wvd",
    "wvd_file_marker": "DEMO_WVD_FILE_NOT_A_REAL_DEVICE",
    "widevine_key_id": "DEMO_KEY_ID_NOT_SET",
    "widevine_content_key": "DEMO_CONTENT_KEY_NOT_SET",
    "playplay_binary_path": "./demo/PLAYPLAY_PLACEHOLDER.bin",
    "spotify_cookie": "sp_dc=DEMO_COOKIE_NOT_REAL",
    "account_password": "DEMO_PASSWORD_NOT_USED",
    "account_token": "DEMO_ACCOUNT_TOKEN_NOT_REAL",
}

I18N: Final = {
    "bg": {
        "title": "DyrakArmy – Демо на защитени входове",
        "language": "Език:",
        "intro": (
            "Този прозорец показва само фиктивна структура за документация и UI тестове. "
            "Стойностите не се записват автоматично, не се изпращат към двигател и не участват в декриптиране."
        ),
        "field": "Поле",
        "value": "Фиктивна стойност",
        "copy": "Копирай безопасен JSON",
        "export": "Запази примерен JSON",
        "close": "Затвори",
        "copied": "Примерният JSON е копиран в клипборда.",
        "saved": "Примерният JSON е записан.",
        "warning": (
            "Не поставяй реални cookies, пароли, account tokens, CDM профили, WVD файлове или ключове тук. "
            "Това е демонстрационен екран."
        ),
    },
    "en": {
        "title": "DyrakArmy – Protected inputs demo",
        "language": "Language:",
        "intro": (
            "This window shows a fake structure for documentation and UI testing only. "
            "Values are not automatically persisted, sent to an engine, or used for decryption."
        ),
        "field": "Field",
        "value": "Fake value",
        "copy": "Copy safe JSON",
        "export": "Save example JSON",
        "close": "Close",
        "copied": "The example JSON was copied to the clipboard.",
        "saved": "The example JSON was saved.",
        "warning": (
            "Do not place real cookies, passwords, account tokens, CDM profiles, WVD files, or keys here. "
            "This is a demonstration screen."
        ),
    },
}


def demo_payload() -> dict[str, object]:
    """Return a non-functional example payload suitable for docs and UI tests."""
    return {
        "demo_only": True,
        "purpose": "UI schema preview; no authentication or decryption",
        "fields": dict(DEMO_FIELDS),
        "capabilities": {
            "network_access": False,
            "subprocess_execution": False,
            "credential_storage": False,
            "key_loading": False,
            "drm_decryption": False,
        },
    }


def validate_demo_payload(payload: dict[str, object]) -> bool:
    """Reject a payload if a placeholder was replaced with a plausible real secret."""
    if payload.get("demo_only") is not True:
        return False
    fields = payload.get("fields")
    if not isinstance(fields, dict) or set(fields) != set(DEMO_FIELDS):
        return False
    markers = ("DEMO", "EXAMPLE", "PLACEHOLDER", "NOT_SET", "NOT_REAL", "NOT_USED")
    return all(any(marker in str(value).upper() for marker in markers) for value in fields.values())


class ProtectedInputsDemo:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.geometry("900x520")
        self.root.minsize(760, 440)
        self.lang_var = tk.StringVar(value="bg")

        outer = ttk.Frame(root, padding=14)
        outer.pack(fill=tk.BOTH, expand=True)
        outer.columnconfigure(0, weight=1)
        outer.rowconfigure(2, weight=1)

        header = ttk.Frame(outer)
        header.grid(row=0, column=0, sticky="ew", pady=(0, 10))
        header.columnconfigure(0, weight=1)
        self.title_label = ttk.Label(header, font=("Segoe UI", 15, "bold"))
        self.title_label.grid(row=0, column=0, sticky="w")
        self.lang_label = ttk.Label(header)
        self.lang_label.grid(row=0, column=1, padx=(8, 4))
        language = ttk.Combobox(
            header,
            textvariable=self.lang_var,
            values=("bg", "en"),
            width=5,
            state="readonly",
        )
        language.grid(row=0, column=2)
        language.bind("<<ComboboxSelected>>", lambda _event: self.translate())

        self.intro_label = ttk.Label(outer, wraplength=850)
        self.intro_label.grid(row=1, column=0, sticky="ew", pady=(0, 10))

        table_frame = ttk.Frame(outer)
        table_frame.grid(row=2, column=0, sticky="nsew")
        table_frame.columnconfigure(0, weight=1)
        table_frame.rowconfigure(0, weight=1)

        self.table = ttk.Treeview(table_frame, columns=("field", "value"), show="headings")
        self.table.grid(row=0, column=0, sticky="nsew")
        self.table.column("field", width=240, anchor="w")
        self.table.column("value", width=560, anchor="w")
        scrollbar = ttk.Scrollbar(table_frame, command=self.table.yview)
        scrollbar.grid(row=0, column=1, sticky="ns")
        self.table.configure(yscrollcommand=scrollbar.set)

        for name, value in DEMO_FIELDS.items():
            self.table.insert("", tk.END, values=(name, value))

        self.warning_label = ttk.Label(outer, wraplength=850, foreground="#8a3b00")
        self.warning_label.grid(row=3, column=0, sticky="ew", pady=(10, 8))

        actions = ttk.Frame(outer)
        actions.grid(row=4, column=0, sticky="ew")
        self.copy_button = ttk.Button(actions, command=self.copy_json)
        self.copy_button.pack(side=tk.LEFT)
        self.export_button = ttk.Button(actions, command=self.export_json)
        self.export_button.pack(side=tk.LEFT, padx=(8, 0))
        self.close_button = ttk.Button(actions, command=root.destroy)
        self.close_button.pack(side=tk.RIGHT)

        self.translate()

    @property
    def text(self) -> dict[str, str]:
        return I18N.get(self.lang_var.get(), I18N["bg"])

    def translate(self) -> None:
        t = self.text
        self.root.title(APP_TITLE)
        self.title_label.configure(text=t["title"])
        self.lang_label.configure(text=t["language"])
        self.intro_label.configure(text=t["intro"])
        self.warning_label.configure(text=t["warning"])
        self.table.heading("field", text=t["field"])
        self.table.heading("value", text=t["value"])
        self.copy_button.configure(text=t["copy"])
        self.export_button.configure(text=t["export"])
        self.close_button.configure(text=t["close"])

    def _serialized(self) -> str:
        payload = demo_payload()
        if not validate_demo_payload(payload):
            raise RuntimeError("Demo payload validation failed")
        return json.dumps(payload, ensure_ascii=False, indent=2)

    def copy_json(self) -> None:
        try:
            content = self._serialized()
            self.root.clipboard_clear()
            self.root.clipboard_append(content)
            self.root.update_idletasks()
            messagebox.showinfo("DyrakArmy", self.text["copied"])
        except Exception as exc:
            messagebox.showerror("DyrakArmy", str(exc))

    def export_json(self) -> None:
        destination = filedialog.asksaveasfilename(
            defaultextension=".json",
            initialfile="protected-inputs.demo.json",
            filetypes=(("JSON", "*.json"), ("All files", "*.*")),
        )
        if not destination:
            return
        try:
            with open(destination, "w", encoding="utf-8") as handle:
                handle.write(self._serialized())
                handle.write("\n")
            messagebox.showinfo("DyrakArmy", self.text["saved"])
        except Exception as exc:
            messagebox.showerror("DyrakArmy", str(exc))


def main() -> None:
    root = tk.Tk()
    ProtectedInputsDemo(root)
    root.mainloop()


if __name__ == "__main__":
    main()
