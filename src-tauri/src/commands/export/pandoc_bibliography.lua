-- Pandoc filter: lay out a Typst bibliography as bibliography paragraphs.
--
-- Typst's HTML holds a bibliography in a section with the role
-- `doc-bibliography`: a heading, then a bullet list whose bullets are hidden
-- with CSS. Pandoc ignores that CSS, so without this filter the entries become
-- a bulleted list.
--
-- In Word and ODT files each entry becomes a paragraph in the "Bibliography"
-- style, with a tab between its label (`[1]`), if it has one, and its text;
-- `pandoc_bibliography.rs` sets that style's indent. Other formats get the
-- classes Pandoc's own citation processor uses, which its LaTeX writer lays out.
--
-- Uses only functions found in older Pandoc versions (2.9 and later).

local RAW_TAB = {
  docx = pandoc.RawInline('openxml', '<w:r><w:tab/></w:r>'),
  odt = pandoc.RawInline('opendocument', '<text:tab/>'),
}

local function append_all(list, items)
  for _, item in ipairs(items) do
    list[#list + 1] = item
  end
end

-- Lay out the label that starts an entry. Returns the inlines unchanged when
-- there is none, or when no text follows it in the paragraph. The label may sit inside the span Pandoc makes for the
-- entry's link target.
local function lay_out_label(inlines)
  local first = inlines[1]
  if not first or first.t ~= 'Span' then
    return inlines
  end
  if not first.classes:includes('prefix') then
    local inner = lay_out_label(first.content)
    local out = {pandoc.Span(inner, first.attr)}
    append_all(out, {table.unpack(inlines, 2)})
    return out
  end

  local body_start = 2
  if inlines[2] and inlines[2].t == 'Space' then
    body_start = 3
  end
  local body = {table.unpack(inlines, body_start)}
  if #body == 0 then
    return inlines
  end
  if RAW_TAB[FORMAT] then
    local out = {pandoc.Span(first.content), RAW_TAB[FORMAT]}
    append_all(out, body)
    return out
  elseif FORMAT == 'latex' then
    return {
      pandoc.Span(first.content, pandoc.Attr('', {'csl-left-margin'})),
      pandoc.Span(body, pandoc.Attr('', {'csl-right-inline'})),
    }
  end
  return inlines
end

-- Pandoc's ODT writer applies a custom style only to paragraphs directly inside
-- the styled Div, so each paragraph gets its own.
local function styled(block)
  if not RAW_TAB[FORMAT] then
    return block
  end
  return pandoc.Div({block}, pandoc.Attr('', {}, {['custom-style'] = 'Bibliography'}))
end

-- The paragraphs of an entry, each styled. Styles with several blocks per entry
-- put some in nested Divs.
local function entry_blocks(blocks, out)
  for _, block in ipairs(blocks) do
    if block.t == 'Plain' or block.t == 'Para' then
      out[#out + 1] = styled(pandoc.Para(lay_out_label(block.content)))
    elseif block.t == 'Div' then
      local inner = entry_blocks(block.content, {})
      out[#out + 1] = pandoc.Div(inner, block.attr)
    else
      out[#out + 1] = block
    end
  end
  return out
end

function Div(div)
  if div.attributes.role ~= 'doc-bibliography' then
    return nil
  end

  local classes = {'references', 'csl-bib-body'}
  if div.classes:includes('hanging-indent') then
    classes[#classes + 1] = 'hanging-indent'
  end

  local out = {}
  for _, block in ipairs(div.content) do
    if block.t == 'BulletList' then
      local entries = {}
      for _, item in ipairs(block.content) do
        entries[#entries + 1] =
          pandoc.Div(entry_blocks(item, {}), pandoc.Attr('', {'csl-entry'}))
      end
      out[#out + 1] = pandoc.Div(entries, pandoc.Attr('', classes))
    else
      out[#out + 1] = block
    end
  end
  return out
end
