import { REMOVED_TOOLS } from '../removed-tools.js';

describe('REMOVED_TOOLS', () => {
  test('contains all tools removed in v2.7.0', () => {
    expect(Object.keys(REMOVED_TOOLS).sort()).toEqual(
      [
        'get_attribute',
        'get_script_analysis',
        'move_object',
        'rename_object',
        'upload_decal',
      ].sort()
    );
  });

  test('get_script_analysis explanation mentions Luau and grep_scripts', () => {
    const msg = REMOVED_TOOLS.get_script_analysis;
    expect(msg).toMatch(/v2\.7\.0/);
    expect(msg).toMatch(/Luau/);
    expect(msg).toMatch(/grep_scripts/);
  });

  test('upload_decal explanation points to upload_asset', () => {
    expect(REMOVED_TOOLS.upload_decal).toMatch(/upload_asset/);
  });

  test('move_object and rename_object explanations point to set_property with propertyValue', () => {
    expect(REMOVED_TOOLS.move_object).toMatch(/set_property/);
    expect(REMOVED_TOOLS.move_object).toMatch(/propertyValue/);
    expect(REMOVED_TOOLS.rename_object).toMatch(/set_property/);
    expect(REMOVED_TOOLS.rename_object).toMatch(/propertyValue/);
  });

  test('get_attribute explanation points to get_attributes', () => {
    expect(REMOVED_TOOLS.get_attribute).toMatch(/get_attributes/);
  });

  test('unknown name returns undefined', () => {
    expect((REMOVED_TOOLS as Record<string, string | undefined>).never_existed).toBeUndefined();
  });
});
