-- Pandoc filter: turn Typst's footnotes into real footnotes.
--
-- Typst's HTML marks a footnote in the text with a superscript link to an entry
-- in a list at the end of the document. Pandoc's HTML reader expects other
-- markup, and drops that list along with every footnote's text.
-- `pandoc_footnotes.rs` renames the list's role so that the reader keeps it, and
-- this filter moves each entry to where the text refers to it.
--
-- Word can't hold a footnote inside a footnote, so an inner one becomes text in
-- parentheses. An entry nothing refers to stays at the end of the document, so
-- that no text is lost.
--
-- Uses only functions found in older Pandoc versions (2.9 and later).

local ROLE = 'inkycap-endnotes'

-- Footnotes by id: their content, the list item they came from, and whether
-- they have been placed in the text.
local notes = {}
-- The ids in document order.
local order = {}

-- The id a superscript link points to, or nil if it isn't one.
local function reference_target(superscript)
  local link = superscript.content[1]
  if #superscript.content == 1 and link.t == 'Link' then
    return link.target:match('^#(.+)$')
  end
end

local function is_paragraph(block)
  return block ~= nil and (block.t == 'Plain' or block.t == 'Para')
end

-- The inlines without the number that links an entry back to the text.
local function without_backlink(inlines)
  local first = inlines[1]
  if first and first.t == 'Superscript' and reference_target(first) then
    return {table.unpack(inlines, 2)}
  end
  return inlines
end

-- Read a list entry's id and content. Pandoc keeps the entry's id on a span
-- around a single paragraph, or on a Div around several blocks.
local function read_entry(item)
  local blocks, id = item, nil
  local first = item[1]
  if first and first.t == 'Div' and first.identifier ~= '' then
    id = first.identifier
    blocks = {table.unpack(first.content)}
    for i = 2, #item do
      blocks[#blocks + 1] = item[i]
    end
  elseif is_paragraph(first) then
    local span = first.content[1]
    if span and span.t == 'Span' and span.identifier ~= '' then
      id = span.identifier
      local inlines = {table.unpack(span.content)}
      for i = 2, #first.content do
        inlines[#inlines + 1] = first.content[i]
      end
      blocks = {pandoc.Para(inlines), table.unpack(item, 2)}
    end
  end
  if not id then
    return nil
  end

  if is_paragraph(blocks[1]) then
    local inlines = without_backlink(blocks[1].content)
    if #inlines == 0 and #blocks > 1 then
      blocks = {table.unpack(blocks, 2)}
    else
      blocks = {pandoc.Para(inlines), table.unpack(blocks, 2)}
    end
  end
  return id, blocks
end

-- Take the list of footnotes out of the document. What can't be read as a
-- footnote stays.
local function collect(div)
  if div.attributes.role ~= ROLE then
    return nil
  end
  local rest = {}
  for _, block in ipairs(div.content) do
    if block.t == 'OrderedList' then
      for _, item in ipairs(block.content) do
        local id, blocks = read_entry(item)
        if id then
          notes[id] = {blocks = blocks, item = item, placed = false}
          order[#order + 1] = id
        else
          for _, b in ipairs(item) do
            rest[#rest + 1] = b
          end
        end
      end
    else
      rest[#rest + 1] = block
    end
  end
  return rest
end

local function walk(blocks, filter)
  return pandoc.walk_block(pandoc.Div(blocks), filter).content
end

-- The content of a footnote, with any footnote inside it put in parentheses.
-- `open` holds the ids being placed, so that a footnote referring to itself
-- ends.
local function content_of(id, open)
  local note = notes[id]
  note.placed = true
  open[id] = true
  local blocks = walk(note.blocks, {
    Superscript = function(superscript)
      local inner = reference_target(superscript)
      if not inner or not notes[inner] or open[inner] then
        return nil
      end
      local out = {pandoc.Space(), pandoc.Str('(')}
      for _, inline in ipairs(pandoc.utils.blocks_to_inlines(content_of(inner, open))) do
        out[#out + 1] = inline
      end
      out[#out + 1] = pandoc.Str(')')
      return out
    end,
  })
  open[id] = nil
  return blocks
end

local function place(superscript)
  local id = reference_target(superscript)
  if id and notes[id] then
    return pandoc.Note(content_of(id, {}))
  end
end

function Pandoc(doc)
  local blocks = walk(doc.blocks, {Div = collect})
  if #order == 0 then
    return nil
  end
  blocks = walk(blocks, {Superscript = place})
  for _, id in ipairs(order) do
    if not notes[id].placed then
      for _, block in ipairs(notes[id].item) do
        blocks[#blocks + 1] = block
      end
    end
  end
  return pandoc.Pandoc(blocks, doc.meta)
end
