import json
import tempfile
import unittest
from pathlib import Path
from threading import Event


ROOT = Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(ROOT))

from pipeline_worker.lines_stage import run_lines_stage
from pipeline_worker.signals_stage import RULE_VERSION, RULE_SPECS, run_signals_stage
from pipeline_worker.structure_stage import _make_title_node, run_structure_tree_stage


class StructureStageTests(unittest.TestCase):
    def test_lines_preserve_blank_raw_text_and_source_mapping(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            parse_dir = root / 'parse'
            lines_dir = root / 'lines'
            parse_dir.mkdir()
            (parse_dir / 'document.md').write_text('# 标题\n\n正文  内容\n', encoding='utf-8')
            (parse_dir / 'blocks.jsonl').write_text(
                '\n'.join([
                    json.dumps({'blockId': 'b-1', 'text': '# 标题', 'source': {'engine': 'direct', 'line': 1}}, ensure_ascii=False),
                    json.dumps({'blockId': 'b-2', 'text': '正文  内容', 'source': {'engine': 'direct', 'line': 3}}, ensure_ascii=False),
                ]) + '\n',
                encoding='utf-8',
            )
            result = run_lines_stage(str(parse_dir), str(lines_dir), Event(), lambda *_args: None, 'lines-test')
            self.assertEqual(result['lines'], 3)
            lines = [json.loads(value) for value in (lines_dir / 'lines.jsonl').read_text(encoding='utf-8').splitlines()]
            self.assertEqual(lines[1]['normalizedText'], '')
            self.assertEqual(lines[0]['rawText'], '# 标题')
            self.assertEqual(lines[0]['blockId'], 'b-1')
            self.assertTrue((lines_dir / 'checkpoint.json').is_file())

    def test_lines_restore_compacted_blank_context_for_signal_scoring(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            parse_dir = root / 'parse'
            lines_dir = root / 'lines'
            signals_dir = root / 'signals'
            parse_dir.mkdir()
            (parse_dir / 'document.md').write_text('# 标题\n1、项目背景\n正文\n', encoding='utf-8')
            (parse_dir / 'line-layout.jsonl').write_text('\n'.join([
                json.dumps({'lineNo': 1, 'blankBefore': False}, ensure_ascii=False),
                json.dumps({'lineNo': 2, 'blankBefore': True}, ensure_ascii=False),
                json.dumps({'lineNo': 3, 'blankBefore': True}, ensure_ascii=False),
            ]) + '\n', encoding='utf-8')
            (parse_dir / 'blocks.jsonl').write_text('\n'.join([
                json.dumps({'blockId': 'b-1', 'text': '# 标题', 'source': {'engine': 'direct', 'line': 1}}, ensure_ascii=False),
                json.dumps({'blockId': 'b-2', 'text': '1、项目背景', 'source': {'engine': 'direct', 'line': 3}}, ensure_ascii=False),
                json.dumps({'blockId': 'b-3', 'text': '正文', 'source': {'engine': 'direct', 'line': 5}}, ensure_ascii=False),
            ]) + '\n', encoding='utf-8')

            result = run_lines_stage(str(parse_dir), str(lines_dir), Event(), lambda *_args: None, 'compact-lines-test')
            self.assertEqual(result['lines'], 3)
            lines = [json.loads(value) for value in (lines_dir / 'lines.jsonl').read_text(encoding='utf-8').splitlines()]
            self.assertEqual([line['normalizedText'] for line in lines], ['# 标题', '1、项目背景', '正文'])
            self.assertTrue(lines[1]['blankBefore'])
            self.assertTrue(lines[2]['blankBefore'])

            run_signals_stage(str(lines_dir / 'lines.jsonl'), str(signals_dir), 'compact-test', 'hash', Event(), lambda *_args: None, 'compact-signals-test')
            signals = [signal for batch in (json.loads(value) for value in (signals_dir / 'signals.jsonl').read_text(encoding='utf-8').splitlines()) for signal in batch['signals']]
            self.assertEqual(signals[1]['type'], 'HEADING')
            self.assertTrue(signals[1]['scoreBreakdown']['blankBeforeDetected'])
            self.assertTrue(signals[1]['scoreBreakdown']['blankAfterDetected'])

    def test_fenced_code_heading_is_not_document_title_or_duplicate_tree_heading(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            parse_dir = root / 'parse'
            lines_dir = root / 'lines'
            signals_dir = root / 'signals'
            ambiguity_dir = root / 'ambiguity'
            tree_dir = root / 'tree'
            parse_dir.mkdir()
            ambiguity_dir.mkdir()
            markdown_lines = [
                '文档前言。',
                '## **入库全链路总览**',
                '正文内容。',
                '## **第二节**',
                '这一节的正文内容。',
                '```css',
                '# 该文档的唯一标识。系统通过此 ID 定位文档本体。',
                '```',
            ]
            (parse_dir / 'document.md').write_text('\n'.join(markdown_lines) + '\n', encoding='utf-8')
            (parse_dir / 'blocks.jsonl').write_text(
                '\n'.join(json.dumps({
                    'blockId': f'b-{index:06d}',
                    'text': text,
                    'source': {'engine': 'direct', 'line': index},
                }, ensure_ascii=False) for index, text in enumerate(markdown_lines, 1)) + '\n',
                encoding='utf-8',
            )

            run_lines_stage(str(parse_dir), str(lines_dir), Event(), lambda *_args: None, 'fenced-lines-test')
            lines = [json.loads(value) for value in (lines_dir / 'lines.jsonl').read_text(encoding='utf-8').splitlines()]
            self.assertTrue(lines[6]['inCodeFence'])
            self.assertFalse(lines[1]['inCodeFence'])

            run_signals_stage(str(lines_dir / 'lines.jsonl'), str(signals_dir), 'doc-fenced', 'hash', Event(), lambda *_args: None, 'fenced-signals-test')
            batches = [json.loads(value) for value in (signals_dir / 'signals.jsonl').read_text(encoding='utf-8').splitlines()]
            self.assertNotIn('documentTitle', batches[0])
            signals = [signal for batch in batches for signal in batch['signals']]
            self.assertEqual(signals[1]['type'], 'HEADING')
            self.assertEqual(signals[6]['type'], 'BODY')
            self.assertEqual(signals[6]['ruleId'], 'fenced-code')

            (ambiguity_dir / 'ambiguity.jsonl').write_text(
                '\n'.join(json.dumps(batch, ensure_ascii=False) for batch in batches) + '\n',
                encoding='utf-8',
            )
            run_structure_tree_stage(str(ambiguity_dir), str(tree_dir), 'doc-fenced', 'hash', Event(), lambda *_args: None, 'fenced-tree-test')
            nodes = [json.loads(value) for value in (tree_dir / 'structure.jsonl').read_text(encoding='utf-8').splitlines()]
            self.assertEqual(sum(node['type'] == 'DOCUMENT_TITLE' for node in nodes), 0)
            heading = next(node for node in nodes if node['type'] == 'HEADING' and node.get('firstLineNo') == 2)
            self.assertEqual(heading['text'], '入库全链路总览')
            sibling_heading = next(node for node in nodes if node['type'] == 'HEADING' and node.get('firstLineNo') == 4)
            self.assertEqual([item['text'] for item in sibling_heading['sectionPath']], ['第二节'])
            preamble = next(node for node in nodes if node.get('firstLineNo') == 1)
            body = next(node for node in nodes if node.get('firstLineNo') == 3)
            second_body = next(node for node in nodes if node.get('firstLineNo') == 5)
            code_comment = next(node for node in nodes if node.get('firstLineNo') == 7)
            self.assertEqual(preamble['sectionPath'], [])
            self.assertEqual([item['text'] for item in body['sectionPath']], ['入库全链路总览'])
            self.assertEqual([item['text'] for item in second_body['sectionPath']], ['第二节'])
            self.assertEqual(code_comment['type'], 'BODY')

    def test_signal_priority_and_counter_examples(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            lines_dir = root / 'lines'
            signals_dir = root / 'signals'
            lines_dir.mkdir()
            values = [
                '', '第 3 页', '# Markdown 标题', '第一步：安装', '第一章 总则',
                '附录 A 接口', '1.2 适用范围', '| 名称 | 说明 |', '| --- | --- |',
                '> 引用', '- [x] 完成', '- 列表', '1. 有序项', '（一）范围',
                '普通正文内容。', '版本 1.2 已发布。', 'A | B 是两个条件。',
            ]
            (lines_dir / 'lines.jsonl').write_text('\n'.join(json.dumps({'lineNo': i + 1, 'rawText': value, 'normalizedText': value, 'blockId': f'b-{i + 1:03d}', 'source': {'engine': 'test'}}) for i, value in enumerate(values)) + '\n', encoding='utf-8')
            result = run_signals_stage(str(lines_dir / 'lines.jsonl'), str(signals_dir), 'doc-test', 'hash-test', Event(), lambda *_args: None, 'signals-test')
            self.assertEqual(result['lines'], len(values))
            batches = [json.loads(value) for value in (signals_dir / 'signals.jsonl').read_text(encoding='utf-8').splitlines()]
            signals = [signal for batch in batches for signal in batch['signals']]
            self.assertEqual(len(signals), len(values))
            self.assertEqual([signal['type'] for signal in signals[:14]], [
                'BLANK', 'NOISE', 'HEADING', 'STEP_ITEM', 'HEADING', 'HEADING',
                'HEADING', 'TABLE_ROW', 'TABLE_ROW', 'QUOTE', 'LIST_ITEM',
                'LIST_ITEM', 'HEADING_CANDIDATE', 'HEADING_CANDIDATE',
            ])
            self.assertEqual(signals[14]['type'], 'BODY')
            self.assertEqual(signals[15]['type'], 'BODY')
            self.assertEqual(signals[16]['type'], 'BODY')
            self.assertEqual(batches[0]['documentTitle']['type'], 'DOCUMENT_TITLE')
            self.assertEqual(batches[0]['signals'][0]['ruleVersion'], RULE_VERSION)

    def test_repeated_template_heading_near_document_top_is_not_noise(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            lines_dir = root / 'lines'
            signals_dir = root / 'signals'
            lines_dir.mkdir()
            values = [
                '内部公开', '', '## 岗位职责', '1、研发体系管理', '内部公开',
                '', '## 任职要求', '1、五年以上经验', '内部公开', '',
                '## 岗位职责', '1、架构治理', '内部公开', '', '## 岗位职责', '1、交付管理',
            ]
            (lines_dir / 'lines.jsonl').write_text(
                '\n'.join(json.dumps({
                    'lineNo': index + 1,
                    'rawText': value,
                    'normalizedText': value,
                    'blockId': f'b-{index + 1:03d}',
                    'source': {'engine': 'test'},
                }, ensure_ascii=False) for index, value in enumerate(values)) + '\n',
                encoding='utf-8',
            )

            run_signals_stage(
                str(lines_dir / 'lines.jsonl'),
                str(signals_dir),
                'doc-template',
                'hash-template',
                Event(),
                lambda *_args: None,
                'signals-template-test',
            )
            signals = [signal for batch in (json.loads(value) for value in (signals_dir / 'signals.jsonl').read_text(encoding='utf-8').splitlines()) for signal in batch['signals']]
            # 纯文本重复跑头出现在文首/文尾时仍按噪声过滤。
            self.assertEqual(signals[0]['type'], 'NOISE')
            self.assertEqual(signals[4]['type'], 'NOISE')
            # 模板式文档中重复出现且靠近文首的显式小节标题必须保留为标题。
            heading_signals = [signal for signal in signals if signal['normalizedText'] == '## 岗位职责']
            self.assertEqual(len(heading_signals), 3)
            for signal in heading_signals:
                self.assertEqual(signal['type'], 'HEADING')
                self.assertEqual(signal['ruleId'], 'markdown-heading')

    def test_separator_lines_are_not_heading_candidates(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            lines_dir = root / 'lines'
            signals_dir = root / 'signals'
            lines_dir.mkdir()
            values = [
                '# 标题', '', '---', '正文内容。', '***', '##', '- - -',
                '——————', '## 适用范围', '***强调***', '- 列表项',
            ]
            (lines_dir / 'lines.jsonl').write_text(
                '\n'.join(json.dumps({
                    'lineNo': index + 1,
                    'rawText': value,
                    'normalizedText': value,
                    'blockId': f'b-{index + 1:03d}',
                    'source': {'engine': 'test'},
                }, ensure_ascii=False) for index, value in enumerate(values)) + '\n',
                encoding='utf-8',
            )

            run_signals_stage(
                str(lines_dir / 'lines.jsonl'),
                str(signals_dir),
                'doc-separator',
                'hash-separator',
                Event(),
                lambda *_args: None,
                'signals-separator-test',
            )
            signals = [signal for batch in (json.loads(value) for value in (signals_dir / 'signals.jsonl').read_text(encoding='utf-8').splitlines()) for signal in batch['signals']]
            by_text = {signal['normalizedText']: signal for signal in signals}
            # 后面没有文字的符号行/裸标题标记是分隔符，而不是候选标题。
            for separator_text in ('---', '***', '##', '- - -', '——————'):
                self.assertEqual(by_text[separator_text]['type'], 'SEPARATOR')
                self.assertEqual(by_text[separator_text]['ruleId'], 'separator')
            self.assertEqual(by_text['## 适用范围']['type'], 'HEADING')
            self.assertEqual(by_text['***强调***']['type'], 'HEADING_CANDIDATE')
            self.assertEqual(by_text['- 列表项']['type'], 'LIST_ITEM')

    def test_separator_resets_list_stack_in_tree(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            lines_dir = root / 'lines'
            signals_dir = root / 'signals'
            ambiguity_dir = root / 'ambiguity'
            tree_dir = root / 'tree'
            lines_dir.mkdir()
            ambiguity_dir.mkdir()
            values = ['# 标题', '- 列表一', '  - 子项', '---', '  - 列表二']
            (lines_dir / 'lines.jsonl').write_text(
                '\n'.join(json.dumps({
                    'lineNo': index + 1,
                    'rawText': value,
                    'normalizedText': value,
                    'blockId': f'b-{index + 1:03d}',
                    'source': {'engine': 'test'},
                }, ensure_ascii=False) for index, value in enumerate(values)) + '\n',
                encoding='utf-8',
            )

            run_signals_stage(str(lines_dir / 'lines.jsonl'), str(signals_dir), 'doc-sep-tree', 'hash-sep-tree', Event(), lambda *_args: None, 'signals-sep-tree-test')
            batches = [json.loads(value) for value in (signals_dir / 'signals.jsonl').read_text(encoding='utf-8').splitlines()]
            (ambiguity_dir / 'ambiguity.jsonl').write_text('\n'.join(json.dumps(batch, ensure_ascii=False) for batch in batches) + '\n', encoding='utf-8')
            run_structure_tree_stage(str(ambiguity_dir), str(tree_dir), 'doc-sep-tree', 'hash-sep-tree', Event(), lambda *_args: None, 'tree-sep-test')
            nodes = [json.loads(value) for value in (tree_dir / 'structure.jsonl').read_text(encoding='utf-8').splitlines()]
            separator_node = next(node for node in nodes if node['type'] == 'SEPARATOR')
            self.assertEqual(separator_node['text'], '---')
            first_item = next(node for node in nodes if node['text'] == '- 列表一')
            second_item = next(node for node in nodes if node['text'] == '- 列表二')
            # 分隔符必须切断列表嵌套：缩进项之后的分隔符不能让后续项挂回旧列表。
            self.assertEqual(second_item['parentId'], first_item['parentId'])

    def test_ambiguous_outline_score_uses_sequence_colon_and_blank_context(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            lines_dir = root / 'lines'
            signals_dir = root / 'signals'
            lines_dir.mkdir()
            values = ['', '1、项目背景', '', '包含以下内容：', '1、第一项', '2、第二项', '普通正文。', '（一）第一项', '（二）第二项']
            (lines_dir / 'lines.jsonl').write_text(
                '\n'.join(json.dumps({
                    'lineNo': index + 1,
                    'rawText': value,
                    'normalizedText': value,
                    'blockId': f'b-{index + 1:03d}',
                    'source': {'engine': 'test'},
                }, ensure_ascii=False) for index, value in enumerate(values)) + '\n',
                encoding='utf-8',
            )

            run_signals_stage(
                str(lines_dir / 'lines.jsonl'),
                str(signals_dir),
                'doc-score-test',
                'hash-score-test',
                Event(),
                lambda *_args: None,
                'signals-score-test',
            )
            batches = [json.loads(value) for value in (signals_dir / 'signals.jsonl').read_text(encoding='utf-8').splitlines()]
            signals = [signal for batch in batches for signal in batch['signals']]

            self.assertEqual(signals[1]['type'], 'HEADING')
            self.assertEqual(signals[1]['confidence'], 0.9)
            self.assertTrue(signals[1]['scoreBreakdown']['blankBeforeDetected'])
            self.assertTrue(signals[1]['scoreBreakdown']['blankAfterDetected'])
            self.assertEqual(signals[4]['type'], 'LIST_ITEM')
            self.assertEqual(signals[4]['confidence'], 0.1)
            self.assertTrue(signals[4]['scoreBreakdown']['sequenceDetected'])
            self.assertTrue(signals[4]['scoreBreakdown']['previousColon'])
            self.assertEqual(signals[5]['type'], 'LIST_ITEM')
            self.assertEqual(signals[5]['confidence'], 0.35)
            self.assertTrue(signals[5]['scoreBreakdown']['sequenceDetected'])
            self.assertEqual(signals[7]['type'], 'LIST_ITEM')
            self.assertEqual(signals[7]['confidence'], 0.35)
            self.assertEqual(signals[7]['scoreBreakdown']['markerFamily'], 'chinese')
            self.assertTrue(signals[7]['scoreBreakdown']['sequenceDetected'])

    def test_ambiguous_outline_without_context_stays_candidate(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            lines_dir = root / 'lines'
            signals_dir = root / 'signals'
            lines_dir.mkdir()
            value = '1、项目背景'
            (lines_dir / 'lines.jsonl').write_text(json.dumps({
                'lineNo': 1,
                'rawText': value,
                'normalizedText': value,
                'blockId': 'b-001',
                'source': {'engine': 'test'},
            }, ensure_ascii=False) + '\n', encoding='utf-8')

            run_signals_stage(
                str(lines_dir / 'lines.jsonl'),
                str(signals_dir),
                'doc-candidate-test',
                'hash-candidate-test',
                Event(),
                lambda *_args: None,
                'signals-candidate-test',
            )
            signal = json.loads((signals_dir / 'signals.jsonl').read_text(encoding='utf-8').splitlines()[0])['signals'][0]
            self.assertEqual(signal['type'], 'HEADING_CANDIDATE')
            self.assertEqual(signal['confidence'], 0.7)
            self.assertEqual(signal['ruleId'], 'ambiguous-outline-score')

    def test_rule_fixtures_have_stable_version_and_both_sides(self):
        self.assertTrue(RULE_VERSION.startswith('p3-'))
        self.assertGreaterEqual(len(RULE_SPECS), 10)
        for rule in RULE_SPECS:
            self.assertEqual(rule['version'], RULE_VERSION)
            self.assertTrue(rule['positive'])
            self.assertTrue(rule['negative'])

    def test_title_prefers_explicit_heading_over_quoted_example_and_keeps_source(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            lines_dir = root / 'lines'
            signals_dir = root / 'signals'
            ambiguity_dir = root / 'ambiguity'
            tree_dir = root / 'tree'
            lines_dir.mkdir()
            ambiguity_dir.mkdir()
            values = [
                '假设下面是存入的文档:',
                '',
                '> **D-501:《技术团队人事档案》**',
                '> 张三于2025年加入腾讯公司。',
                '',
                '# 入库全链路总览',
                '正文内容。',
            ]
            records = [
                {
                    'lineNo': index + 1,
                    'rawText': value,
                    'normalizedText': value,
                    'blockId': f'b-{index + 1:06d}',
                    'source': {'engine': 'direct', 'line': index + 1},
                }
                for index, value in enumerate(values)
            ]
            (lines_dir / 'lines.jsonl').write_text(
                '\n'.join(json.dumps(record, ensure_ascii=False) for record in records) + '\n',
                encoding='utf-8',
            )

            run_signals_stage(
                str(lines_dir / 'lines.jsonl'),
                str(signals_dir),
                'doc-title-test',
                'hash-title-test',
                Event(),
                lambda *_args: None,
                'signals-title-test',
            )

            batch = json.loads((signals_dir / 'signals.jsonl').read_text(encoding='utf-8').splitlines()[0])
            title = batch['documentTitle']
            self.assertEqual(title['normalizedText'], '入库全链路总览')
            self.assertEqual(title['rawText'], '# 入库全链路总览')
            self.assertEqual(title['derivedFromType'], 'HEADING')
            self.assertEqual(title['source']['derivedFromLineNo'], 6)
            self.assertEqual(title['source']['blockId'], 'b-000006')
            self.assertEqual(batch['signals'][2]['type'], 'QUOTE')

            title_node = _make_title_node(title, 'doc-title-test', 'hash-title-test')
            self.assertEqual(title_node['text'], '入库全链路总览')
            self.assertEqual(title_node['sourceRefs'][0]['derivedFromLineNo'], 6)
            self.assertEqual(title_node['sourceRefs'][0]['blockId'], 'b-000006')

            # Parser provenance can point to a different original line after
            # blank-line compaction; derivedFromLineNo remains logical.
            title['source']['line'] = 60
            (ambiguity_dir / 'ambiguity.jsonl').write_text(json.dumps(batch, ensure_ascii=False) + '\n', encoding='utf-8')
            run_structure_tree_stage(str(ambiguity_dir), str(tree_dir), 'doc-title-test', 'hash-title-test', Event(), lambda *_args: None, 'tree-title-test')
            nodes = [json.loads(value) for value in (tree_dir / 'structure.jsonl').read_text(encoding='utf-8').splitlines()]
            self.assertEqual(sum(node['type'] == 'DOCUMENT_TITLE' for node in nodes), 1)
            self.assertFalse(any(node['type'] == 'HEADING' and node.get('firstLineNo') == 6 for node in nodes))
            self.assertEqual(next(node for node in nodes if node.get('firstLineNo') == 1)['sectionPath'], [])
            self.assertEqual([item['text'] for item in next(node for node in nodes if node.get('firstLineNo') == 7)['sectionPath']], ['入库全链路总览'])

    def test_multiple_h1_headings_remain_root_siblings(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            lines_dir = root / 'lines'
            signals_dir = root / 'signals'
            ambiguity_dir = root / 'ambiguity'
            tree_dir = root / 'tree'
            lines_dir.mkdir()
            ambiguity_dir.mkdir()
            values = [
                '# 项目经理',
                '## 岗位职责',
                '1. **研发体系管理**：掌握瀑布式与敏捷开发两套流程。',
                '## 任职要求',
                '1. **技术理解力**：能够理解大模型推理机制。',
                '---',
                '# 智能体 FDE 工程师',
                '## 岗位职责',
                '### 1. 客户场景理解与方案落地',
                '面向 ToB/ToG 客户理解业务流程。',
                '## 任职要求',
                '### 1. 技术理解力',
            ]
            records = [
                {
                    'lineNo': index + 1,
                    'rawText': value,
                    'normalizedText': value,
                    'blockId': f'b-{index + 1:06d}',
                    'source': {'engine': 'direct', 'line': index + 1},
                }
                for index, value in enumerate(values)
            ]
            (lines_dir / 'lines.jsonl').write_text(
                '\n'.join(json.dumps(record, ensure_ascii=False) for record in records) + '\n',
                encoding='utf-8',
            )

            run_signals_stage(
                str(lines_dir / 'lines.jsonl'),
                str(signals_dir),
                'doc-multiple-h1',
                'hash-multiple-h1',
                Event(),
                lambda *_args: None,
                'signals-multiple-h1-test',
            )
            batches = [json.loads(value) for value in (signals_dir / 'signals.jsonl').read_text(encoding='utf-8').splitlines()]
            self.assertNotIn('documentTitle', batches[0])

            (ambiguity_dir / 'ambiguity.jsonl').write_text(
                '\n'.join(json.dumps(batch, ensure_ascii=False) for batch in batches) + '\n',
                encoding='utf-8',
            )
            run_structure_tree_stage(
                str(ambiguity_dir),
                str(tree_dir),
                'doc-multiple-h1',
                'hash-multiple-h1',
                Event(),
                lambda *_args: None,
                'tree-multiple-h1-test',
            )
            nodes = [json.loads(value) for value in (tree_dir / 'structure.jsonl').read_text(encoding='utf-8').splitlines()]
            self.assertFalse(any(node['type'] == 'DOCUMENT_TITLE' for node in nodes))

            project_manager = next(node for node in nodes if node.get('firstLineNo') == 1)
            project_duties = next(node for node in nodes if node.get('firstLineNo') == 2)
            fde_engineer = next(node for node in nodes if node.get('firstLineNo') == 7)
            fde_duties = next(node for node in nodes if node.get('firstLineNo') == 8)
            fde_scenario = next(node for node in nodes if node.get('firstLineNo') == 9)

            self.assertEqual((project_manager['parentId'], project_manager['depth'], project_manager['headingLevel']), ('n-root', 1, 1))
            self.assertEqual((fde_engineer['parentId'], fde_engineer['depth'], fde_engineer['headingLevel']), ('n-root', 1, 1))
            self.assertEqual((project_duties['parentId'], project_duties['depth'], project_duties['headingLevel']), (project_manager['nodeId'], 2, 2))
            self.assertEqual((fde_duties['parentId'], fde_duties['depth'], fde_duties['headingLevel']), (fde_engineer['nodeId'], 2, 2))
            self.assertEqual((fde_scenario['parentId'], fde_scenario['depth'], fde_scenario['headingLevel']), (fde_duties['nodeId'], 3, 3))
            self.assertEqual([item['text'] for item in fde_scenario['sectionPath']], ['智能体 FDE 工程师', '岗位职责', '1. 客户场景理解与方案落地'])

    def test_h1_after_title_scan_window_prevents_title_promotion(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            lines_dir = root / 'lines'
            signals_dir = root / 'signals'
            lines_dir.mkdir()
            values = ['# 第一岗位', *(f'正文内容 {index}' for index in range(2, 52)), '# 第二岗位']
            (lines_dir / 'lines.jsonl').write_text(
                '\n'.join(json.dumps({
                    'lineNo': index + 1,
                    'rawText': value,
                    'normalizedText': value,
                    'blockId': f'b-{index + 1:06d}',
                    'source': {'engine': 'direct', 'line': index + 1},
                }, ensure_ascii=False) for index, value in enumerate(values)) + '\n',
                encoding='utf-8',
            )

            run_signals_stage(
                str(lines_dir / 'lines.jsonl'),
                str(signals_dir),
                'doc-late-h1',
                'hash-late-h1',
                Event(),
                lambda *_args: None,
                'signals-late-h1-test',
            )

            batch = json.loads((signals_dir / 'signals.jsonl').read_text(encoding='utf-8').splitlines()[0])
            self.assertNotIn('documentTitle', batch)

    def test_quote_is_not_used_as_document_title_without_a_real_candidate(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            lines_dir = root / 'lines'
            signals_dir = root / 'signals'
            lines_dir.mkdir()
            values = ['> **D-501:《技术团队人事档案》**', '正文内容。']
            (lines_dir / 'lines.jsonl').write_text(
                '\n'.join(json.dumps({
                    'lineNo': index + 1,
                    'rawText': value,
                    'normalizedText': value,
                    'blockId': f'b-{index + 1:06d}',
                    'source': {'engine': 'direct', 'line': index + 1},
                }, ensure_ascii=False) for index, value in enumerate(values)) + '\n',
                encoding='utf-8',
            )

            run_signals_stage(
                str(lines_dir / 'lines.jsonl'),
                str(signals_dir),
                'doc-quote-test',
                'hash-quote-test',
                Event(),
                lambda *_args: None,
                'signals-quote-test',
            )

            batch = json.loads((signals_dir / 'signals.jsonl').read_text(encoding='utf-8').splitlines()[0])
            self.assertNotIn('documentTitle', batch)
            self.assertEqual(batch['signals'][0]['type'], 'QUOTE')


if __name__ == '__main__':
    unittest.main()
