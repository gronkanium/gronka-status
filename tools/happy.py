# The status page's all-clear penguin: idle's body with happy arched eyes and a grin, drawn by the
# mascot's own code so it matches every other pose. `MASCOT_DIR=<mascot project> python3 tools/happy.py`
import os
import sys
from pathlib import Path

MASCOT = Path(os.environ['MASCOT_DIR'])
sys.path.insert(0, str(MASCOT))
import web  # noqa: E402

web.POSES['happy'] = (web.P(eye='happy', bk='grin'), 3)
out = Path(__file__).resolve().parent.parent / 'public/p/happy.svg'
out.write_text(web.render('happy'))
print(out)
