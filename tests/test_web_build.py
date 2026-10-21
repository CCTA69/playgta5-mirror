import unittest
import json
import subprocess
from build_web import patch_page, patch_worker


class WebBuildTests(unittest.TestCase):
    def test_resumed_activity_clears_stale_pause_without_hiding_errors(self):
        # The archived page resets the warning colour but leaves its pause text.
        code = """// game-progress
function tick(quiet) {
    if (quiet > 30) { label.textContent = 'No progress for 40 s: loading has paused.'; label.style.color = '#e96'; stallLogged = quiet; }
    else if (stallLogged) { stallLogged = 0; label.style.color = ''; }
}
"""
        result = patch_page('const q = new URLSearchParams(location.search);\n' + code)
        script = "const assert=require('node:assert/strict'); const location={search:''}; let stallLogged=0,lastLabel='First frame',label={textContent:lastLabel,style:{color:''}};" + result + """
tick(40); assert.match(label.textContent, /No progress/);
tick(0); assert.equal(label.textContent, 'First frame'); assert.equal(label.style.color, '');
for (const warningColour of ['#e96', 'rgb(238, 153, 102)']) {
    tick(40); label.textContent=lastLabel='Preparing shaders'; label.style.color=warningColour;
    tick(0); assert.equal(label.textContent,'Preparing shaders'); assert.equal(label.style.color,'');
}
tick(40); label.textContent='Engine failed'; label.style.color='#e66';
tick(0); assert.equal(label.textContent,'Engine failed'); assert.equal(label.style.color,'#e66');
assert.equal(stallLogged,0);
"""
        completed = subprocess.run(['node', '-e', script], capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_static_prefetch_removes_backend_dependency(self):
        code = 'try { if (wanted.size) await batchFetch(full, true, wanted); } catch (e) {}'
        result = patch_worker(code)
        script = "const full=[{id:1,a:0,b:2},{id:2,a:3,b:4}]; const wanted=new Set([2]); const calls=[]; async function ensureBlocks(...args){calls.push(args);} async function batchFetch(){throw Error('Backend must not be used');} (async()=>{" + result + ";console.log(JSON.stringify(calls));})();"
        completed = subprocess.run(['node', '-e', script], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(completed.stdout), [[2, 3, 4, True]])

    def test_hosted_defaults_preserve_explicit_user_settings(self):
        result = patch_page('const q = new URLSearchParams(location.search);')
        for query, expected in [('', {'low': '1', 'fps': '30', 'res': '1280x720'}), ('?low=0&fps=60&res=1920x1080', {'low':'0','fps':'60','res':'1920x1080'})]:
            script = 'const location={search:' + json.dumps(query) + '};' + result + ';console.log(JSON.stringify(Object.fromEntries(q)));'
            completed = subprocess.run(['node', '-e', script], capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(completed.stdout), expected)

    def test_unknown_or_already_patched_snapshots_fail_closed(self):
        for fn, text in [(patch_page, 'changed snapshot'), (patch_worker, 'changed worker')]:
            with self.assertRaises(ValueError):
                fn(text)


if __name__ == '__main__':
    unittest.main()
