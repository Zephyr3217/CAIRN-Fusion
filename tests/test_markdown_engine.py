import unittest
from cairn.markdown_engine import headings, append_under_heading, AmbiguousHeading, HeadingNotFound

class MarkdownEngineTests(unittest.TestCase):
    def test_append_safety(self):
        src="# Thesis\n\n## Introduction\nText A\n\n## Methodology\nText B\n\n## Conclusion\nText C\n"
        out=append_under_heading(src,"New methodology paragraph.",heading='Methodology')
        self.assertIn("## Introduction\nText A",out)
        self.assertIn("## Conclusion\nText C",out)
        self.assertIn("## Methodology\nText B\n\nNew methodology paragraph.",out)
        self.assertEqual(src.split('## Methodology')[0],out.split('## Methodology')[0])
        self.assertEqual('## Conclusion'+src.split('## Conclusion',1)[1],'## Conclusion'+out.split('## Conclusion',1)[1])
    def test_code_fence_heading_is_not_target(self):
        src='# Development\n\n## Code\n\n```markdown\n## Fake Heading\n```\n\n## Notes\nReal notes.\n'
        names=[h.title for h in headings(src)]
        self.assertNotIn('Fake Heading',names)
        with self.assertRaises(HeadingNotFound): append_under_heading(src,'x',heading='Fake Heading')
    def test_duplicate_heading_is_ambiguous(self):
        src='# Thesis\n\n## Model\nA\n\n# Appendix\n\n## Model\nB\n'
        with self.assertRaises(AmbiguousHeading): append_under_heading(src,'x',heading='Model')
        out=append_under_heading(src,'X',heading_path=['Appendix','Model'])
        self.assertIn('## Model\nB\n\nX',out)

if __name__=='__main__': unittest.main()
