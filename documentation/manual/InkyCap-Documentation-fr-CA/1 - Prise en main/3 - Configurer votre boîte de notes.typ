#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Configurer votre boîte de notes",
  description: "Comment fonctionne une boîte de notes (un dossier portable de notes .typ accompagné d'une configuration .inkycap cachée), les trois façons d'en démarrer une, et comment organiser, ouvrir et changer de boîte de notes.",
  tags: ("documentation",),
)

= Configurer votre boîte de notes

== Ce qu'est une boîte de notes

Une *boîte de notes* est simplement un dossier sur votre ordinateur. À l'intérieur vivent vos notes (un fichier par note) aux côtés d'un petit dossier de paramètres caché qu'InkyCap entretient pour vous. Il n'y a aucun format de fichier propriétaire pour vous enfermer : ce sont de simples fichiers texte sur disque, que vous pouvez copier, sauvegarder, synchroniser ou consulter avec n'importe quel outil que vous utilisez déjà.

InkyCap travaille toujours à l'intérieur d'une boîte de notes. Quand vous ouvrez l'application, vous ouvrez une boîte de notes ; tout ce que vous écrivez, reliez et organisez lui appartient.

Chaque note est un fichier au format Typst (se terminant par `.typ`). C'est ce qui rend une boîte de notes si portable. Vous pouvez ouvrir le même dossier dans d'autres outils Typst et vos notes se compileront. Les informations structurées qu'InkyCap ajoute (titres, étiquettes, liens, et ainsi de suite, abordés dans #wikilink("6 - Propriétés des notes")) sont stockées d'une façon que les autres programmes Typst peuvent lire.

#callout("note")[ Un dossier devient une boîte de notes lorsqu'InkyCap y ajoute un dossier caché `.inkycap/`. C'est par ce dossier qu'InkyCap (et tout outil coopérant) reconnaît le dossier comme une boîte de notes. ]

#callout("tip", title: "Pour les utilisatrices et utilisateurs de Typst")[ Chaque note commence par une seule ligne d'importation ajoutée automatiquement :
```typ
#import "/.inkycap/notebox.typ": *
```
Comme les propriétés de la boîte de notes sont émises sous forme de `#metadata` Typst étiquetés, vous pouvez les lire depuis l'extérieur d'InkyCap avec l'outil en ligne de commande standard (aucun processus InkyCap requis) :
```
typst query path/to/note.typ "<inkycap-note>" --field value --one
```
Les étiquettes utilisent le label `<inkycap-tag>` et les liens utilisent `<inkycap-link>`. Les chemins qu'InkyCap inscrit dans vos notes (pour les images, les fichiers de données et les bibliographies) commencent par `/`, que Typst résout par rapport à la racine de la boîte de notes, de sorte qu'ils restent corrects à mesure que les notes se déplacent. ]

== Trois façons de démarrer une boîte de notes

Vous pouvez démarrer une boîte de notes de trois façons. La première est la plus courante et est décrite en détail ci-dessous ; les deux autres sont de brefs renvois vers des pages plus complètes.

Vous trouverez les trois dans *Paramètres*, sous la section *Gestion des boîtes de notes* (voir #wikilink("2 - Paramètres")) :

+ *Nouvelle boîte de notes* crée une boîte de notes vide sur votre propre ordinateur. Partez de zéro, ou copiez vos fichiers et préférences depuis une boîte de notes que vous possédez déjà.
+ *Cloner depuis un dépôt distant* télécharge une boîte de notes existante depuis un dépôt Git partagé pour y travailler avec d'autres personnes en ligne.
+ *Importer un package* crée une boîte de notes à partir d'un fichier package qu'une collaboratrice ou un collaborateur vous a envoyé (par exemple, en pièce jointe d'un courriel).

=== Créer une nouvelle boîte de notes

C'est le chemin que la plupart des gens empruntent au début.

+ Ouvrez *Paramètres* et trouvez *Gestion des boîtes de notes*, ou (si aucune boîte de notes n'est encore ouverte) utilisez le bouton *Ouvrir ou créer une boîte de notes…* dans l'écran d'accueil.
+ Choisissez *Nouvelle boîte de notes*. Un sélecteur de dossier s'ouvre, à partir de votre dossier personnel.
+ Choisissez un dossier vide (ou créez-en un nouveau) où vous aimeriez que vos notes vivent, et confirmez.

Ouvrir un dossier qui n'est pas encore une boîte de notes le transforme en boîte de notes. InkyCap ajoute le dossier caché `.inkycap/` et quelques templates de notes de départ, et vous voilà prêt à écrire.
\

*Copier depuis une boîte de notes existante.* Si vous possédez déjà une autre boîte de notes et que vous pointez InkyCap vers un dossier neuf et vide, il propose d'apporter vos préférences. Vous verrez une invite *Copier à partir d'une boîte de notes existante?* :

- Choisissez *Copier et ouvrir* pour reprendre vos paramètres, vos règles de création de notes, vos scaffolds (les « templates » de notes propres à InkyCap) et vos définitions de propriétés typées depuis l'une de vos autres boîtes de notes.
- Choisissez *Utiliser les valeurs par défaut* (ou appuyez sur Échap) pour repartir à neuf.

Cela copie vos *préférences*, pas vos notes. Vos notes existantes restent là où elles sont. Les chemins de fichiers absolus présents dans les paramètres copiés (comme un fichier de bibliographie ou un style de citation personnalisé) ne sont conservés que s'ils pointent toujours vers quelque chose de réel sur cet ordinateur.

=== Rejoindre une boîte de notes partagée en ligne

Si une collègue ou un collègue a déposé une boîte de notes dans un dépôt git partagé, utilisez *Cloner depuis un dépôt distant* pour télécharger une copie de travail et collaborer. Vous fournirez l'adresse du dépôt et, au besoin, un nom d'utilisateur et un mot de passe. Voyez #wikilink("1 - Collaboration") pour la marche à suivre complète.

=== Rejoindre une boîte de notes partagée hors ligne

Si une collaboratrice ou un collaborateur vous a envoyé une boîte de notes sous forme de fichier package (lorsque vous n'utilisez pas de serveur partagé ou pour des raisons de confidentialité), utilisez *Importer un package*. Si le package était chiffré, on vous demandera son mot de passe. #wikilink("1 - Collaboration") couvre cela aussi.

#callout("note")[ Apporter et convertir une pile de fichiers Markdown existants est une tâche différente. Il s'agit d'*importer des notes dans une boîte de notes que vous possédez déjà*, et non de créer une boîte de notes. Voyez #wikilink("2 - Importer des notes existantes"). ]

== Organiser vos notes

À l'intérieur d'une boîte de notes, vous pouvez arranger vos notes en dossiers comme bon vous semble (par sujet, par projet, par cours, ou de toute façon qui correspond à votre manière de penser).

Vous gérez vos notes depuis l'*Arborescence des fichiers* (l'onglet *Fichiers* dans la barre latérale de gauche). À partir de là, vous pouvez :

- Créer une nouvelle note avec le bouton *Nouvelle note* (ou appuyer sur *Ctrl+N*).
- Créer un *Nouveau dossier* pour regrouper des notes apparentées.
- Utiliser *Copier dans la boîte de notes* pour apporter des fichiers de l'extérieur.
- *Réduire tous les dossiers* ou *Développer tous les dossiers* pour épurer votre vue.
- *Trier les fichiers* pour changer leur ordre : par nom, par date de modification ou de création, ou par identifiant Zettelkasten (voir #wikilink("2 - Paramètres")), chacun en ordre croissant ou décroissant.


=== Les noms de notes doivent être uniques

Les liens wiki trouvent une note par son seul nom, sans tenir compte du dossier où elle vit ; deux notes d'une même boîte de notes ne peuvent donc pas porter le même nom. Si vous essayez de créer une note dont le nom est déjà pris, InkyCap s'arrête et vous offre un choix : *Ouvrir la note existante*, *Ajouter un ZID* (qui garde les deux en ajoutant un identifiant unique au nouveau nom ; offert lorsque les identifiants Zettelkasten sont activés), ou *Utiliser un nom différent*.

Les notes qui arrivent d'autres outils peuvent échapper à cette vérification, et certains noms parfaitement valides sous Linux ne peuvent pas exister sous Windows ou macOS. Pour repérer les deux types de problème, ouvrez la palette de commandes (*Ctrl+P*) et lancez *Vérifier les noms de fichiers pour les problèmes multiplateformes ou les doublons*. Le *Rapport de noms InkyCap* qui s'ouvre liste chaque nom qui demande votre attention, explique pourquoi, et vous permet d'ouvrir la note dans un nouvel onglet pour la corriger. Utilisez *Réanalyser* après avoir renommé, ou *Enregistrer le rapport* pour en garder une copie. La vérification ne fait que rapporter ; elle ne renomme jamais rien à votre place.

#callout("tip")[ Vous préférez des noms plus épurés ? Le paramètre *Afficher les extensions de nom de fichier dans l'arborescence* vous permet de masquer le `.typ` final pour que les notes apparaissent comme de simples titres. ]

== Le dossier Assets

Les images, les PDF et les autres fichiers que vous ajoutez à vos notes ont besoin d'un endroit où vivre. Par défaut, c'est un dossier nommé *Assets* à l'intérieur de votre boîte de notes. Quand vous glissez une image, en collez une ou en insérez une par la commande `/`, InkyCap la classe sous *Assets*.

Vous pouvez changer l'endroit où InkyCap range ces pièces jointes. Allez dans vos *Paramètres → Fichiers et liens*, dans le champ *Dossier des pièces jointes*. Si vous le renommez là (au moyen de *Renommer le dossier…*), InkyCap déplacera chaque fichier existant et réécrira chaque référence dans toute votre boîte de notes pour que rien ne casse.

Pendant que vous êtes dans *Paramètres → Fichiers et liens*, vous pouvez aussi décider où les nouvelles notes sont créées par défaut :

- *Racine de la boîte de notes* est le niveau supérieur de votre boîte de notes (la valeur par défaut).
- *Dossier actuel* est l'endroit où vous travaillez au moment de créer la note.
- *Dossier spécifié* est un dossier fixe que vous nommez.

== Ouvrir des boîtes de notes et en changer

Chaque fenêtre InkyCap contient *une seule boîte de notes à la fois*.

Pour passer à une autre boîte de notes, utilisez le *sélecteur de boîtes de notes* dans la barre d'état, au bas de la fenêtre à gauche. Vos boîtes de notes connues y sont listées ; choisissez-en une pour l'ouvrir. Vous pouvez cliquer sur *Gérer les boîtes de notes...* pour en créer une autre.

Si vous préférez garder votre boîte de notes actuelle ouverte et en avoir une seconde à côté, ouvrez la nouvelle dans sa propre fenêtre :

- Utilisez *Ouvrir dans une nouvelle fenêtre* depuis la barre d'état, ou
- Appuyez sur *Ctrl+Shift+N*.

#callout("note")[ La même boîte de notes ne peut pas être ouverte dans deux fenêtres en même temps. Dans le sélecteur, une boîte de notes ouverte ailleurs apparaît grisée avec une mention *Ouvrir dans une autre fenêtre*. ]

Quand vous lancez InkyCap, il rouvre la boîte de notes que vous avez utilisée en dernier. S'il n'y a rien à rouvrir, vous verrez un écran *Ouvrez une boîte de notes pour continuer* listant vos boîtes de notes. Choisissez-en une, ou créez-en une nouvelle, pour démarrer.

Ce qu'InkyCap affiche une fois la boîte de notes ouverte dépend de vous. Le paramètre *Comportement au démarrage* (sous *Comportement* dans #wikilink("2 - Paramètres")) peut afficher une arborescence de fichiers vierge, votre dernier fichier ouvert, une page ou une collection particulière, ou *Onglets précédemment ouverts*, qui restaure chaque onglet que vous aviez ouvert la dernière fois que vous avez fermé cette boîte de notes, y compris l'onglet où vous étiez ainsi que le mode d'édition et le zoom de chaque onglet. Cet enregistrement est gardé sur votre propre ordinateur, pas dans la boîte de notes ; partager ou synchroniser la boîte de notes ne l'emporte donc pas avec elle.

#callout("important")[ Retirer une boîte de notes de cette liste ne fait qu'amener InkyCap à l'oublier. Votre dossier et toutes vos notes restent bien en sécurité sur le disque ; vous pouvez toujours la rajouter plus tard. ]

== Pages connexes

- #wikilink("1 - Prise en main")
- #wikilink("2 - Paramètres")
- #wikilink("6 - Propriétés des notes")
- #wikilink("3 - Scaffolds, Templates et Packages")
- #wikilink("2 - Importer des notes existantes")
- #wikilink("1 - Collaboration")
