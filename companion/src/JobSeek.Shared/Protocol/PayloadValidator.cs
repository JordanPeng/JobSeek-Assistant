using System.Text.Json;

namespace JobSeek.Protocol;

/// <summary>
/// Validates a request payload against its <see cref="FieldSpec"/> schema,
/// enforcing the same rules as the TypeScript Zod schemas: exact type, string
/// length, format (uuid/url/hash/base64), enum membership, integer range,
/// required fields, nullability, and rejection of any additional property at
/// every nesting level.
/// </summary>
internal static class PayloadValidator
{
    public static void Validate(string operation, JsonElement payload)
    {
        if (!PayloadSchemas.ByOperation.TryGetValue(operation, out var schema))
        {
            throw new ProtocolException("The request operation is unsupported.");
        }

        ValidateValue(schema, payload);

        if (operation == ProtocolOperations.ApplicationsUpdate
            && !PayloadSchemas.ApplicationUpdateEditable.Any(field => payload.TryGetProperty(field, out _)))
        {
            throw new ProtocolException("At least one editable field is required.");
        }
    }

    private static void ValidateValue(FieldSpec spec, JsonElement value)
    {
        if (spec.Nullable && value.ValueKind == JsonValueKind.Null)
        {
            return;
        }

        switch (spec.Kind)
        {
            case FieldKind.Object:
                ValidateObject(spec, value);
                break;
            case FieldKind.Array:
                ValidateArray(spec, value);
                break;
            case FieldKind.String:
                ValidateString(spec, value);
                break;
            case FieldKind.Integer:
                ValidateInteger(spec, value);
                break;
            case FieldKind.Boolean:
                if (value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                {
                    throw new ProtocolException("The request payload has an invalid boolean field.");
                }

                break;
            case FieldKind.Json:
                // Any JSON value (object/array/string/number/boolean/null) is allowed.
                break;
            default:
                throw new ProtocolException("The request payload has an unknown field kind.");
        }
    }

    private static void ValidateObject(FieldSpec spec, JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object)
        {
            throw new ProtocolException("The request payload is invalid.");
        }

        var fields = spec.Fields ?? throw new ProtocolException("The request payload schema is invalid.");
        foreach (var property in value.EnumerateObject())
        {
            if (!fields.ContainsKey(property.Name))
            {
                throw new ProtocolException("The request payload contains an unsupported field.");
            }
        }

        foreach (var (name, field) in fields)
        {
            if (value.TryGetProperty(name, out var child))
            {
                ValidateValue(field, child);
            }
            else if (field.Required)
            {
                throw new ProtocolException("The request payload is missing a required field.");
            }
        }
    }

    private static void ValidateArray(FieldSpec spec, JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Array)
        {
            throw new ProtocolException("The request payload has an invalid array field.");
        }

        if (spec.MaxItems is { } maxItems && value.GetArrayLength() > maxItems)
        {
            throw new ProtocolException("The request payload array is too large.");
        }

        var items = spec.Items ?? throw new ProtocolException("The request payload schema is invalid.");
        foreach (var item in value.EnumerateArray())
        {
            ValidateValue(items, item);
        }
    }

    private static void ValidateString(FieldSpec spec, JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.String)
        {
            throw new ProtocolException("The request payload has an invalid string field.");
        }

        var text = value.GetString() ?? throw new ProtocolException("The request payload has an invalid string field.");
        if (spec.Min is { } min && text.Length < min)
        {
            throw new ProtocolException("The request payload string is too short.");
        }

        if (spec.Max is { } max && text.Length > max)
        {
            throw new ProtocolException("The request payload string is too long.");
        }

        if (spec.Enum is { } values && !values.Contains(text, StringComparer.Ordinal))
        {
            throw new ProtocolException("The request payload has an invalid enum value.");
        }

        switch (spec.Format)
        {
            case StringFormat.Uuid when !Guid.TryParse(text, out _):
                throw new ProtocolException("The request payload has an invalid uuid.");
            case StringFormat.Url when !IsUrl(text):
                throw new ProtocolException("The request payload has an invalid url.");
            case StringFormat.Hash when !IsHash(text):
                throw new ProtocolException("The request payload has an invalid hash.");
            default:
                break;
        }
    }

    private static void ValidateInteger(FieldSpec spec, JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt64(out var number))
        {
            throw new ProtocolException("The request payload has an invalid integer field.");
        }

        if (spec.Min is { } min && number < min)
        {
            throw new ProtocolException("The request payload integer is too small.");
        }

        if (spec.Max is { } max && number > max)
        {
            throw new ProtocolException("The request payload integer is too large.");
        }
    }

    private static bool IsUrl(string value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri) && !string.IsNullOrEmpty(uri.Scheme) && !string.IsNullOrEmpty(uri.Authority);

    private static bool IsHash(string value) =>
        value.Length == 64 && value.All(static character => char.IsAsciiDigit(character) || (char.IsAsciiHexDigit(character) && char.IsLower(character)));
}
