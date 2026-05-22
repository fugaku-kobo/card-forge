# -*- coding: utf-8 -*-
"""手塚カードゲーム v7 ツール共通 — データファイルの場所とバックアップ。

版管理: data/手塚カードゲーム_v7_vX.Y.xlsx(版番号つきファイル名)。
スクリプトは常に最新版を対象に編集する。バックアップは data/backups/(git管理外)。
"""
import os, glob, re, shutil, sys
from datetime import datetime

DATA_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data'))
BACKUP_DIR = os.path.join(DATA_DIR, 'backups')


def latest_xlsx():
    """data/ 内の最新版 手塚カードゲーム_v7_vX.Y.xlsx のパスを返す。"""
    files = glob.glob(os.path.join(DATA_DIR, '手塚カードゲーム_v7_v*.xlsx'))
    if not files:
        sys.exit('ERROR: data/ に 手塚カードゲーム_v7_vX.Y.xlsx がありません')

    def ver(path):
        m = re.search(r'_v(\d+)\.(\d+)\.xlsx$', os.path.basename(path))
        return (int(m.group(1)), int(m.group(2))) if m else (0, 0)
    return max(files, key=ver)


def backup(xlsx):
    """xlsx を data/backups/ にタイムスタンプ付きで退避し、退避先パスを返す。"""
    os.makedirs(BACKUP_DIR, exist_ok=True)
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    base = os.path.basename(xlsx).replace('.xlsx', '_backup_%s.xlsx' % ts)
    dst = os.path.join(BACKUP_DIR, base)
    shutil.copy2(xlsx, dst)
    return dst
