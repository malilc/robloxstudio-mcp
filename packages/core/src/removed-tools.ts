export const REMOVED_TOOLS: Record<string, string> = {
  get_script_analysis:
    'get_script_analysis was removed in v2.7.0. It used loadstring which parses Lua 5.1 and reported Luau-only syntax (type annotations, continue, etc.) as compile errors. Use grep_scripts to find syntactic patterns instead, or rely on Studio\'s built-in Script Analysis pane.',
  upload_decal:
    'upload_decal was removed in v2.7.0. Use upload_asset with assetType: "Decal" which supports both cookie and Open Cloud auth.',
  move_object:
    'move_object was removed in v2.7.0. Use set_property with propertyName: "Parent" and propertyValue set to the target parent\'s path.',
  rename_object:
    'rename_object was removed in v2.7.0. Use set_property with propertyName: "Name" and propertyValue set to the new name string.',
  get_attribute:
    'get_attribute (single) was removed in v2.7.0. Use get_attributes which returns the full attribute map.',
};
