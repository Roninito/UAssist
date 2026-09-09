using System;
using System.Collections;
using System.Net.Http;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace UAssist.Editor
{
    /// <summary>
    /// Dockable UAssist window for Unity Editor.
    /// Sends selection events and can create cards against selected assets/GameObjects.
    /// </summary>
    public class UAssistWindow : EditorWindow
    {
        private static readonly HttpClient Client = new HttpClient();
        private const string BaseUrl = "http://127.0.0.1:7373";
        private string _status = "Idle";
        private Vector2 _scroll;

        [MenuItem("Window/UAssist")]
        public static void ShowWindow()
        {
            GetWindow<UAssistWindow>("UAssist");
        }

        private void OnEnable()
        {
            Selection.selectionChanged += OnSelectionChanged;
            EditorApplication.update += PollHealth;
        }

        private void OnDisable()
        {
            Selection.selectionChanged -= OnSelectionChanged;
            EditorApplication.update -= PollHealth;
        }

        private void OnSelectionChanged()
        {
            var active = Selection.activeObject;
            if (active == null) return;

            var path = AssetDatabase.GetAssetPath(active);
            var payload = new
            {
                kind = "selection",
                asset_path = path,
                type = active.GetType().FullName,
                timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
            };

            PostJson("/events", payload);
        }

        private void PollHealth()
        {
            // Poll infrequently; in a real implementation use a longer timer.
            if (EditorApplication.timeSinceStartup % 30 < Time.deltaTime)
            {
                _ = FetchHealth();
            }
        }

        private async System.Threading.Tasks.Task FetchHealth()
        {
            try
            {
                var res = await Client.GetAsync($"{BaseUrl}/health");
                if (res.IsSuccessStatusCode)
                {
                    _status = $"OK: {await res.Content.ReadAsStringAsync()}";
                }
            }
            catch
            {
                _status = "Server unreachable";
            }
        }

        private void OnGUI()
        {
            _scroll = EditorGUILayout.BeginScrollView(_scroll);

            GUILayout.Label("UAssist", EditorStyles.boldLabel);
            EditorGUILayout.LabelField("Status", _status, EditorStyles.wordWrappedLabel);

            GUILayout.Space(12);
            if (GUILayout.Button("Create card for selection"))
            {
                CreateCardForSelection();
            }

            if (GUILayout.Button("Open UAssist desktop app"))
            {
                Application.OpenURL("http://127.0.0.1:7373");
            }

            GUILayout.Space(12);
            GUILayout.Label("Selection", EditorStyles.boldLabel);
            foreach (var obj in Selection.objects)
            {
                EditorGUILayout.LabelField(obj.name, AssetDatabase.GetAssetPath(obj));
            }

            EditorGUILayout.EndScrollView();
        }

        private void CreateCardForSelection()
        {
            var active = Selection.activeObject;
            if (active == null)
            {
                Debug.LogWarning("[UAssist] Nothing selected.");
                return;
            }

            var path = AssetDatabase.GetAssetPath(active);
            var payload = new
            {
                title = $"Review {active.name}",
                category = "unknown",
                anchor = new
                {
                    kind = "unity_asset",
                    path
                }
            };

            PostJson("/cards", payload);
        }

        private async void PostJson<T>(string endpoint, T payload)
        {
            try
            {
                var json = JsonUtility.ToJson(payload);
                var content = new StringContent(json, Encoding.UTF8, "application/json");
                await Client.PostAsync($"{BaseUrl}{endpoint}", content);
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[UAssist] Failed to contact server: {ex.Message}");
            }
        }
    }
}
