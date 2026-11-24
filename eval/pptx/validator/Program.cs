// The schema check of the PowerPoint spike (eval/pptx/README.md), run in CI only: the Open XML
// SDK's validator (MIT) against ECMA-376 as Office writes it. One JSON line per file.
using System.Text.Json;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;

var validator = new OpenXmlValidator(FileFormatVersions.Microsoft365) { MaxNumberOfErrors = 200 };
foreach (var path in args)
{
    object line;
    try
    {
        using var document = PresentationDocument.Open(path, false);
        var errors = validator.Validate(document).ToList();
        line = new
        {
            file = Path.GetFileName(path),
            errors = errors.Count,
            first = errors.Take(5).Select(e => $"{e.Id} {e.Part?.Uri} {e.Path?.XPath}: {e.Description}").ToArray(),
        };
    }
    catch (Exception error)
    {
        line = new { file = Path.GetFileName(path), errors = -1, first = new[] { error.Message } };
    }
    Console.WriteLine(JsonSerializer.Serialize(line));
}
